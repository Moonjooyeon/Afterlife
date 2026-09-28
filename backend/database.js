import './env.js';
export default await import(process.env.DATABASE_URL ? './postgres.js' : './db.js');
