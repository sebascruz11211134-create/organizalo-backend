const DEFAULT_ZONE = 'America/Costa_Rica';
function validateSchedule(c = {}) {
  try { new Intl.DateTimeFormat('en', { timeZone: c.zonaHoraria || DEFAULT_ZONE }); }
  catch { throw new Error('Zona horaria inválida.'); }
  if (!c.horarioInicio && !c.horarioFin) return;
  const valid = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '');
  if (!valid(c.horarioInicio) || !valid(c.horarioFin)) throw new Error('Indicá inicio y fin en formato HH:MM.');
  if (c.horarioInicio === c.horarioFin) throw new Error('Para atender 24 horas, dejá ambos horarios vacíos.');
}
function dentroDelHorario(c = {}, date = new Date()) {
  try { validateSchedule(c); } catch { return false; }
  if (!c.horarioInicio && !c.horarioFin) return true;
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: c.zonaHoraria || DEFAULT_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const now = Number(p.find(x => x.type === 'hour').value) * 60 + Number(p.find(x => x.type === 'minute').value);
  const minutes = v => { const [h,m] = v.split(':').map(Number); return h*60+m; };
  const a = minutes(c.horarioInicio), b = minutes(c.horarioFin);
  return a < b ? now >= a && now < b : now >= a || now < b;
}
module.exports = { validateSchedule, dentroDelHorario, DEFAULT_ZONE };
