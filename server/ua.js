// "Chrome 130 · Windows 10/11" from a user agent string.
export function parseUA(ua) {
  ua = String(ua || '');
  if (!ua) return 'Unknown browser';
  let b = '';
  let m;
  if ((m = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/))) b = 'Edge ' + m[1];
  else if ((m = ua.match(/OPR\/(\d+)/))) b = 'Opera ' + m[1];
  else if ((m = ua.match(/(?:Firefox|FxiOS)\/(\d+)/))) b = 'Firefox ' + m[1];
  else if ((m = ua.match(/(?:Chrome|CriOS)\/(\d+)/))) b = 'Chrome ' + m[1];
  else if ((m = ua.match(/Version\/(\d+)[\d.]*.*Safari/))) b = 'Safari ' + m[1];
  else if (/curl|wget|node|python|bot/i.test(ua)) b = ua.split(/[\s/]/)[0];
  else b = 'Unknown browser';
  let os = '';
  if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
  else if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  const mobile = /Mobile|Android|iPhone/.test(ua) ? ' (mobile)' : '';
  return os ? `${b} · ${os}${mobile}` : b;
}
