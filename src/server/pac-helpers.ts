// These helpers run inside QuickJS. dnsResolve() and myIpAddress() are supplied by the worker.
export const pacHelpers = String.raw`
function alert() {}

function dnsDomainIs(host, domain) {
  return host.endsWith(domain);
}

function dnsDomainLevels(host) {
  return host.split('.').length - 1;
}

function isPlainHostName(host) {
  return !host.includes('.') && !host.includes(':');
}

function localHostOrDomainIs(host, hostdom) {
  return host === hostdom || (isPlainHostName(host) && hostdom.startsWith(host + '.'));
}

function shExpMatch(text, pattern) {
  let pos = 0, token = 0, wildcard = -1, wildcardEnd = 0;
  while (pos < text.length) {
    if (pattern[token] === '*') {
      wildcard = token++;
      wildcardEnd = pos;
    } else if (pattern[token] === '?' || pattern[token] === text[pos]) {
      token++;
      pos++;
    } else if (wildcard >= 0) {
      token = wildcard + 1;
      pos = ++wildcardEnd;
    } else return false;
  }
  while (pattern[token] === '*') token++;
  return token === pattern.length;
}

function isResolvable(host) {
  return dnsResolve(host) !== null;
}

function isInNet(host, pattern, mask) {
  function ipv4(value) {
    if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return null;
    const octets = value.split('.').map(Number);
    if (octets.some(octet => octet > 255)) return null;
    return octets.reduce((address, octet) => address * 256 + octet, 0);
  }
  const net = ipv4(pattern), bits = ipv4(mask);
  if (net === null || bits === null) return false;
  const address = ipv4(host) ?? ipv4(dnsResolve(host));
  return address !== null && (address & bits) === (net & bits);
}

// Keep the range implementation private to avoid adding globals beyond PAC helpers.
Object.assign(globalThis, (() => {
  const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  function clock(args) {
    const now = new Date();
    const utc = args[args.length - 1] === 'GMT';
    if (utc) args.pop();
    return unit => now[(utc ? 'getUTC' : 'get') + unit]();
  }

  function between(now, first, last) {
    return first <= last ? first <= now && now <= last : first <= now || now <= last;
  }

  function isInteger(value, lo, hi) {
    return Number.isInteger(value) && value >= lo && value <= hi;
  }

  function weekdayRange(...args) {
    const now = clock(args)('Day');
    const first = weekdays.indexOf(args[0]);
    const last = args.length === 1 ? first : weekdays.indexOf(args[1]);
    return args.length <= 2 && first >= 0 && last >= 0 && between(now, first, last);
  }

  function timeRange(...args) {
    const current = clock(args);
    const hour = current('Hours');
    if (args.length === 1) return hour === args[0];
    if (![2, 4, 6].includes(args.length)) return false;
    const units = args.length / 2;
    if (args.some((value, index) => !isInteger(value, 0, index % units === 0 ? 23 : 59))) return false;
    const now = [hour, current('Minutes'), current('Seconds')].slice(0, units);
    const time = values => values.reduce((total, unit) => 60 * total + unit, 0);
    return between(time(now), time(args.slice(0, units)), time(args.slice(units)));
  }

  function dateRange(...args) {
    const current = clock(args);
    if (![1, 2, 4, 6].includes(args.length)) return false;
    const units = args.length === 1 ? 1 : args.length / 2;
    const monthDay = (month, day) => month * 32 + day;
    const day = current('Date'), month = current('Month'), year = current('FullYear');
    const keys = { D: day, M: month, Y: year, DM: monthDay(month, day), MY: year * 12 + month,
      DMY: monthDay(year * 12 + month, day) };
    const parts = values => values.map(value => {
      if (isInteger(value, 1, 31)) return ['D', value];
      if (isInteger(value, 32, 9999)) return ['Y', value];
      return ['M', months.indexOf(value)];
    });
    const first = parts(args.slice(0, units));
    const last = args.length === 1 ? first : parts(args.slice(units));
    const format = values => values.map(([kind]) => kind).join('');
    const kind = format(first);
    if (!(kind in keys) || kind !== format(last) || [...first, ...last].some(([, value]) => value < 0)) return false;
    const date = values => {
      let result = 0;
      for (const unit of ['Y', 'M', 'D']) {
        const entry = values.find(([part]) => part === unit);
        if (entry) result = result * (unit === 'M' ? 12 : 32) + entry[1];
      }
      return result;
    };
    return between(keys[kind], date(first), date(last));
  }

  return { weekdayRange, timeRange, dateRange };
})());
`;
