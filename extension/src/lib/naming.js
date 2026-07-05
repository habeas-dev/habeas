// Path templates for sinks. Default: {service}/{yyyy}/{date}-{internalId}.{ext}
export function renderPath(template, ctx) {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    if (k === 'yyyy') return String(ctx.date || '').slice(0, 4);
    return k in ctx ? sanitize(String(ctx[k])) : '';
  });
}
function sanitize(s) {
  return s.replace(/[\\/:*?"<>|]+/g, '-');
}
