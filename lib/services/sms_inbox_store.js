'use strict';
/**
 * Persist inbound SMS for superadmin SMS Inbox.
 * Brand numbers map to brands.telnyx_number; operator lines (437/571) store brand_id NULL.
 */

const { query } = require('../db');
const { logError } = require('../error_logger');

async function persistInboundSms({ from, to, body }) {
  if (!from || !to) return null;
  try {
    const { rows } = await query(
      `INSERT INTO brand_sms_inbox (brand_id, from_number, to_number, body)
       SELECT (
         SELECT id FROM brands
          WHERE telnyx_number = $1
             OR regexp_replace(COALESCE(telnyx_number, ''), '\\D', '', 'g')
              = regexp_replace($1, '\\D', '', 'g')
          LIMIT 1
       ), $2, $1, $3
       RETURNING id, brand_id`,
      [to, from, String(body ?? '')],
    );
    return rows[0] || null;
  } catch (err) {
    logError('[sms_inbox_store] persist failed', err, { from, to });
    return null;
  }
}

module.exports = { persistInboundSms };
