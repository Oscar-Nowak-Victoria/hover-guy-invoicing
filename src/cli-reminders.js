// Runs today's payment reminders once and exits. Use from cron if you'd rather not
// rely on the server's built-in daily schedule:  npm run reminders
import { openDb } from './db.js';
import { runReminders } from './actions.js';
import { closePdf } from './pdf.js';
import { isLive } from './mailer.js';

const db = openDb();
console.log(`Running reminders (${isLive() ? 'LIVE: emails will be sent' : 'test mode: saving to outbox'})`);
const report = await runReminders(db);
console.log(`${report.date}: ${report.sent.length} sent, ${report.skipped.length} skipped, ${report.failed.length} failed`);
await closePdf();
process.exitCode = report.failed.length ? 1 : 0;
