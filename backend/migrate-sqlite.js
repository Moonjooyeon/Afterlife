import './env.js';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import fs from 'node:fs/promises';

if (!process.env.DATABASE_URL || !process.argv[2]) throw new Error('DATABASE_URL and SQLite backup path required');
const sqlite = new DatabaseSync(process.argv[2], { readOnly: true });
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const tables=['app_settings','app_users','purchase_orders','access_passes','usage_sessions','access_pass_charges','gemini_requests','audit_logs'];
try {
 await client.query('BEGIN');
 await client.query(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
 for (const table of tables) {
   const count=Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
   if(count) throw new Error(`Target ${table} is not empty; refusing overwrite`);
   const rows=sqlite.prepare(`SELECT * FROM ${table}`).all();
   for (const row of rows) {
     const cols=Object.keys(row);
     await client.query(`INSERT INTO ${table} (${cols.map(c=>`"${c}"`).join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
   }
   const copied=Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
   if(copied!==rows.length) throw new Error(`Count mismatch: ${table}`);
   console.log(`${table}: ${copied} rows verified`);
 }
 await client.query("SELECT setval(pg_get_serial_sequence('audit_logs','id'),COALESCE((SELECT MAX(id) FROM audit_logs),1),(SELECT COUNT(*)>0 FROM audit_logs))");
 await client.query('COMMIT');
} catch(error) {await client.query('ROLLBACK');throw error;}
finally {sqlite.close();await client.end();}
