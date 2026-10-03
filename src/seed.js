// Loads a starter rate card and one example client so the app isn't empty on first run.
// Safe to run more than once: it only adds what's missing.
import { openDb, listRates, saveRate, listClients, saveClient } from './db.js';

const db = openDb();

if (!listRates(db, true).length) {
  [
    ['Pilot in command, full day', 'Includes flight plan and risk assessment', 'day', 55000],
    ['Pilot in command, half day', 'Up to 4 hours on site', 'half day', 32000],
    ['Visual observer / second pilot, full day', '', 'day', 38000],
    ['Site survey and permissions', '', 'hr', 6000],
    ['Weather standby', 'Beyond the first 2 hours', 'hr', 6000],
    ['Travel', '', 'km', 88],
  ].forEach(([name, detail, unit, unit_price]) => saveRate(db, { name, detail, unit, unit_price }));
  console.log('Added starter rate card. Change prices in Settings > Rate card.');
}

if (!listClients(db).length) {
  saveClient(db, {
    company: 'Example Operator Pty Ltd', contact_name: 'Sam Example', email: 'sam@example.com',
    accounts_email: 'accounts@example.com', address: '1 Example Street\nBallarat VIC 3350',
    notes: 'Example client. Delete or edit me.',
  });
  console.log('Added an example client.');
}
