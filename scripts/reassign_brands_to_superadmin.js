#!/usr/bin/env node
/**
 * Reassign all 20 test brands from the incorrect account_id to robert@auraflux.co's
 * actual Clerk account ID so the brand switcher appears in the dashboard.
 */

const { Pool } = require('pg');
require('dotenv').config();

const OLD_ACCOUNT_ID = 'user_2kxLZH7ckSLZH3d6dCK3hVVqvHs';
const NEW_ACCOUNT_ID = 'user_3DeZESHSt4pqQtkDuYJoGDicm2q'; // robert@auraflux.co Clerk ID

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Reassigning brands...');
    console.log(`  FROM: ${OLD_ACCOUNT_ID}`);
    console.log(`  TO:   ${NEW_ACCOUNT_ID}`);

    const result = await pool.query(
      `UPDATE brands 
       SET account_id = $1 
       WHERE account_id = $2 
       RETURNING id, name`,
      [NEW_ACCOUNT_ID, OLD_ACCOUNT_ID]
    );

    console.log(`\n✅ Updated ${result.rowCount} brands:`);
    result.rows.forEach((row, i) => {
      console.log(`  ${i + 1}. ${row.name}`);
    });

    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main();
