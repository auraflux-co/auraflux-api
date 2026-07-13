'use strict';
/**
 * Outbound voice: WebRTC browser (primary) or optional click-to-call cell bridge.
 * Inbound PSTN → ring online WebRTC agents and bridge on answer.
 */

const { Telnyx } = require('telnyx');
const { logError } = require('../error_logger');
const { postMessage, botConfigured } = require('./slack_bot');
const { notifyVoiceEvent } = require('./telnyx_slack_notify');
const { getLines } = require('./telnyx_line_routing');
const { sipUri, getOnlineAgents, phonePageUrl } = require('./telnyx_webrtc');
const {
  createCall,
  updateCallByControlId,
  finalizeCallByControlId,
} = require('./voice_call_log');

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

function lineKeyFromNumber(e164) {
  const { ca, us } = getLines();
  const n = String(e164 || '').replace(/\D/g, '');
  if (n === ca.replace(/\D/g, '')) return '437';
  if (n === us.replace(/\D/g, '')) return '571';
  return null;
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

async function hangupCall(callControlId) {
  const client = getClient();
  if (!client) throw new Error('Telnyx client missing');
  await client.calls.actions.hangup(callControlId).catch(() => {});
}

async function notifySlack(text, channel) {
  if (!botConfigured()) return;
  const opts = channel ? { channel, text } : { text };
  await postMessage(opts).catch(() => {});
}

async function ringOnlineAgents({ inboundLeg, caller, auraLine }) {
  const agents = await getOnlineAgents();
  if (!agents.length) return { rang: 0, agents: [] };

  let rang = 0;
  const details = [];
  for (const agent of agents) {
    const dest = sipUri(agent.sip_username);
    if (!dest) continue;
    try {
      // Dial WebRTC SIP URI — from=caller so agent UI shows the real caller ID
      const leg = await dialLeg({
        to: dest,
        from: caller || auraLine,
        clientState: {
          flow: 'inbound_webrtc',
          inboundLeg,
          caller,
          auraLine,
          agentClerkId: agent.clerk_user_id,
        },
      });
      rang += 1;
      details.push({
        clerkUserId: agent.clerk_user_id,
        sip: dest,
        callControlId: leg.callControlId,
      });
    } catch (err) {
      logError('[telnyx_voice_control] agent ring failed', err, {
        agent: agent.clerk_user_id,
        inboundLeg,
        dest,
      });
      details.push({
        clerkUserId: agent.clerk_user_id,
        sip: dest,
        error: err.message,
      });
    }
  }
  return { rang, agents: details };
}

/**
 * Place outbound call — cell bridge if configured, else WebRTC phone link.
 */
async function startOutboundCall({ destination, from, slackUserId }) {
  if (!from) throw new Error('Outbound line required (437 or 571)');

  const operator = getOperatorPhone();
  if (operator) {
    const leg = await dialLeg({
      to: operator,
      from,
      clientState: {
        flow: 'outbound_operator',
        destination,
        from,
        slackUserId: slackUserId || null,
      },
    });
    await notifySlack(`📞 Calling your phone — answer to connect to *${destination}* from ${from}.`);
    return { ...leg, operatorPhone: operator, destination, from, mode: 'click_to_call' };
  }

  const lineKey = lineKeyFromNumber(from) || '437';
  const url = phonePageUrl({ dial: destination, line: lineKey });
  const channel = process.env.SLACK_SMS_CHANNEL_ID;
  const mention = slackUserId ? `<@${slackUserId}> ` : '';
  const text = `${mention}📞 Outbound call to *${destination}* from ${lineKey}. <${url}|Open phone to dial>`;
  if (channel) {
    await notifySlack(text, channel);
  } else {
    await notifySlack(text);
  }

  await createCall({
    direction: 'outbound',
    fromNumber: from,
    toNumber: destination,
    auraLine: lineKey,
    status: 'requested',
    slackUserId: slackUserId || null,
    metadata: { mode: 'webrtc_link', phoneUrl: url },
  }).catch(() => {});

  return { destination, from, mode: 'webrtc_link', phoneUrl: url, lineKey };
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

  const { eventType, callControlId, clientState, from, to, direction, callSessionId } = evt;

  // Inbound PSTN — accept call.initiated with incoming/inbound
  const isInboundInit =
    eventType === 'call.initiated'
    && (direction === 'incoming' || direction === 'inbound');

  if (isInboundInit) {
    try {
      const auraLine = to;
      const lineKey = lineKeyFromNumber(auraLine);
      await createCall({
        direction: 'inbound',
        fromNumber: from,
        toNumber: auraLine,
        auraLine: lineKey,
        callControlId,
        callSessionId,
        status: 'ringing',
      });

      const takeUrl = phonePageUrl();
      const agents = await getOnlineAgents();
      if (!agents.length) {
        // Answer then hang up so caller doesn't sit on infinite ringback
        await answerCall(callControlId).catch(() => {});
        await hangupCall(callControlId);
        await notifySlack(
          `📞 Missed inbound to *${auraLine}* from *${from}* — no agents online. <${takeUrl}|Open phone>`,
          process.env.SLACK_SMS_CHANNEL_ID,
        );
        await finalizeCallByControlId(callControlId, { missedReason: 'no agents online' });
        return { handled: true, flow: 'inbound_no_agents' };
      }

      // Answer PSTN so webhook processing can dial agents (prevents endless ring / no bridge)
      await answerCall(callControlId);

      const { rang, agents: ringDetails } = await ringOnlineAgents({
        inboundLeg: callControlId,
        caller: from,
        auraLine,
      });
      console.log('[telnyx_voice_control] inbound ring', { from, to: auraLine, rang, ringDetails });
      await notifySlack(
        rang > 0
          ? `📞 Inbound to *${auraLine}* from *${from}* — ringing ${rang} agent(s) on phone. <${takeUrl}|Open phone>`
          : `📞 Inbound to *${auraLine}* from *${from}* — agents online but SIP ring failed. <${takeUrl}|Open phone>`,
        process.env.SLACK_SMS_CHANNEL_ID,
      );
      return { handled: true, flow: 'inbound_webrtc_ring', rang, ringDetails };
    } catch (err) {
      logError('[telnyx_voice_control] inbound failed', err, { from, callControlId });
      return { handled: true, error: err.message };
    }
  }

  if (eventType === 'call.hangup') {
    const flow = clientState?.flow;

    if (direction === 'incoming') {
      const row = await finalizeCallByControlId(callControlId, {
        missedReason: 'no agent answered',
      });
      return { handled: true, flow: 'hangup', status: row?.status };
    }

    if (flow === 'inbound_webrtc' && clientState?.inboundLeg) {
      const row = await finalizeCallByControlId(clientState.inboundLeg, {
        missedReason: 'agent did not answer',
      });
      return { handled: true, flow: 'hangup_agent', status: row?.status };
    }
  }

  if (eventType !== 'call.answered') return { handled: false };

  const flow = clientState?.flow;

  if (flow === 'outbound_operator') {
    try {
      const dest = clientState.destination;
      const fromLine = clientState.from;
      if (!dest || !fromLine) throw new Error('missing destination or from line');
      const destLeg = await dialLeg({
        to: dest,
        from: fromLine,
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

  if (flow === 'inbound_webrtc') {
    try {
      const inboundLeg = clientState.inboundLeg;
      if (!inboundLeg) throw new Error('missing inbound leg');
      // PSTN leg already answered on call.initiated — just bridge
      await bridgeCalls(inboundLeg, callControlId);
      await updateCallByControlId(inboundLeg, {
        status: 'answered',
        agentClerkId: clientState.agentClerkId || null,
        answeredAt: new Date().toISOString(),
      });
      await notifySlack(`✅ Agent connected to caller *${clientState.caller || from}*`);
      return { handled: true, flow, bridged: true };
    } catch (err) {
      logError('[telnyx_voice_control] inbound webrtc bridge failed', err);
      await hangupCall(clientState.inboundLeg);
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
  lineKeyFromNumber,
  startOutboundCall,
  startOutboundClickToCall,
  handleVoiceControlEvent,
  processVoiceWebhook,
  ringOnlineAgents,
};
