'use strict';
/**
 * Outbound voice: direct dial with cross-line caller ID (no cell required).
 * CA inbound line → outbound from US line and vice versa.
 */

const { Telnyx } = require('telnyx');
const { logError } = require('../error_logger');
const { postMessage, botConfigured } = require('./slack_bot');
const { notifyVoiceEvent } = require('./telnyx_slack_notify');
const {
  outboundLineForInbound,
  outboundLineForDestination,
} = require('./telnyx_line_routing');

let _client = null;
function getClient() {
  if (_client) return _client;
  const key = process.env.TELNYX_API_KEY;
  if (!key) return null;
  _client = new Telnyx(key);
  return _client;
}

function getConnectionId() {
  return process.env.TELNYX_VOICE_CONNECTION_ID
    || process.env.TELNYX_CALL_CONTROL_APP_ID
    || null;
}

function getFromNumber() {
  return process.env.TELNYX_VOICE_FROM_NUMBER
    || process.env.TELNYX_NUMBER
    || null;
}

function getOperatorPhone() {
  return process.env.SLACK_OPERATOR_PHONE
    || process.env.OPERATOR_CALLBACK_PHONE
    || null;
}

function encodeState(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

function decodeState(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function parseVoiceWebhook(req) {
  const evt = req.body?.data;
  if (!evt?.event_type) return null;
  const p = evt.payload || {};
  return {
    eventType:     evt.event_type,
    callControlId: p.call_control_id || null,
    callSessionId: p.call_session_id || null,
    from:          p.from || p.caller_id_number || '',
    to:            p.to || p.called_number || '',
    direction:     p.direction || '',
    state:         p.state || p.hangup_cause || '',
    clientState:   decodeState(p.client_state),
  };
}

async function dialLeg({ to, from, clientState }) {
  const client = getClient();
  const connectionId = getConnectionId();
  const caller = from || getFromNumber();
  if (!client || !connectionId || !caller) {
    throw new Error('Telnyx voice not configured (API key, connection, from number)');
  }
  const resp = await client.calls.dial({
    connection_id: connectionId,
    from: caller,
    to,
    client_state: encodeState(clientState),
  });
  return {
    callControlId: resp.data?.call_control_id || null,
    callSessionId: resp.data?.call_session_id || null,
    from: caller,
    to,
  };
}

async function bridgeCalls(legA, legB) {
  const client = getClient();
  if (!client) throw new Error('Telnyx client missing');
  await client.calls.actions.bridge(legA, {
    call_control_id_to_bridge_with: legB,
  });
}

async function answerCall(callControlId) {
  const client = getClient();
  if (!client) throw new Error('Telnyx client missing');
  await client.calls.actions.answer(callControlId);
}

async function notifySlack(text) {
  if (!botConfigured()) return;
  await postMessage({ text }).catch(() => {});
}

/**
 * Place outbound call — uses paired line when inboundLine known, else by destination.
 */
async function startOutboundCall({ destination, inboundLine, slackUserId }) {
  const from = inboundLine
    ? outboundLineForInbound(inboundLine)
    : outboundLineForDestination(destination);

  const operator = getOperatorPhone();
  if (operator) {
    const leg = await dialLeg({
      to: operator,
      from,
      clientState: {
        flow: 'outbound_operator',
        destination,
        slackUserId: slackUserId || null,
        inboundLine: inboundLine || null,
      },
    });
    await notifySlack(`📞 Calling your phone — answer to connect to *${destination}* from ${from}.`);
    return { ...leg, operatorPhone: operator, destination, from, mode: 'click_to_call' };
  }

  const leg = await dialLeg({
    to: destination,
    from,
    clientState: { flow: 'direct_dial', destination, from },
  });
  await notifySlack(`📞 Dialing *${destination}* from ${from}.`);
  return { ...leg, destination, from, mode: 'direct_dial' };
}

/** @deprecated use startOutboundCall */
async function startOutboundClickToCall(opts) {
  return startOutboundCall(opts);
}

/**
 * Handle Telnyx voice webhook events for call control flows.
 */
async function handleVoiceControlEvent(evt) {
  if (!evt?.eventType || !evt.callControlId) return { handled: false };

  const { eventType, callControlId, clientState, from, to, direction } = evt;

  // Inbound PSTN → ring operator and bridge
  if (eventType === 'call.initiated' && direction === 'incoming') {
    try {
      const pairedFrom = outboundLineForInbound(to);
      await notifySlack(`📞 Inbound call to *${to}* from *${from}* — reply via \`/calling ${from.replace('+', '')}\` to call back from ${pairedFrom}.`);
      return { handled: true, flow: 'inbound_notify' };
    } catch (err) {
      logError('[telnyx_voice_control] inbound failed', err, { from, callControlId });
      return { handled: true, error: err.message };
    }
  }

  if (eventType !== 'call.answered') return { handled: false };

  const flow = clientState?.flow;

  if (flow === 'outbound_operator') {
    try {
      const dest = clientState.destination;
      const from = clientState.inboundLine
        ? outboundLineForInbound(clientState.inboundLine)
        : outboundLineForDestination(dest);
      if (!dest) throw new Error('missing destination in client_state');
      const destLeg = await dialLeg({
        to: dest,
        from,
        clientState: {
          flow: 'outbound_bridge',
          operatorLeg: callControlId,
          destination: dest,
        },
      });
      return { handled: true, flow, destLeg: destLeg.callControlId };
    } catch (err) {
      logError('[telnyx_voice_control] outbound dest dial failed', err);
      await notifySlack(`❌ Could not dial ${clientState.destination}: ${err.message}`);
      return { handled: true, error: err.message };
    }
  }

  if (flow === 'outbound_bridge') {
    try {
      const operatorLeg = clientState.operatorLeg;
      if (!operatorLeg) throw new Error('missing operator leg');
      await bridgeCalls(operatorLeg, callControlId);
      await notifySlack(`✅ Connected to *${clientState.destination || to}*`);
      return { handled: true, flow, bridged: true };
    } catch (err) {
      logError('[telnyx_voice_control] outbound bridge failed', err);
      await notifySlack(`❌ Bridge failed: ${err.message}`);
      return { handled: true, error: err.message };
    }
  }

  if (flow === 'inbound_operator') {
    try {
      const inboundLeg = clientState.inboundLeg;
      if (!inboundLeg) throw new Error('missing inbound leg');
      await bridgeCalls(inboundLeg, callControlId);
      await notifySlack(`✅ Connected to caller *${clientState.caller || from}*`);
      return { handled: true, flow, bridged: true };
    } catch (err) {
      logError('[telnyx_voice_control] inbound bridge failed', err);
      return { handled: true, error: err.message };
    }
  }

  return { handled: false };
}

async function processVoiceWebhook(req) {
  const evt = parseVoiceWebhook(req);
  if (!evt) return;

  const control = await handleVoiceControlEvent(evt);
  if (control.handled) {
    console.log('[telnyx_voice_control]', control);
  }

  // Always mirror call events to Slack for visibility
  notifyVoiceEvent({
    eventType: evt.eventType,
    from: evt.from,
    to: evt.to,
    direction: evt.direction,
    state: evt.state,
    callControlId: evt.callControlId,
  }).catch(() => {});
}

module.exports = {
  encodeState,
  decodeState,
  parseVoiceWebhook,
  getOperatorPhone,
  startOutboundCall,
  startOutboundClickToCall,
  handleVoiceControlEvent,
  processVoiceWebhook,
};
