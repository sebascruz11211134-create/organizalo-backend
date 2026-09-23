const { db } = require('../db');
const { createInbox } = require('./rockyInbox');
const inbox = createInbox(db);
const handlers = {};
let timer;
function register(channel, handler) { handlers[channel] = handler; }
function start() {
  if (timer) return;
  timer = setInterval(() => inbox.tick(handlers).catch(e => console.error('[Rocky inbox]',e.message)), 2000);
  timer.unref();
}
module.exports = { inbox, register, start };
