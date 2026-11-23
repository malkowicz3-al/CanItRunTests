import { randomInt, randomUUID } from 'node:crypto';
import type { Scopes } from '../../shared/api';

const MAX_DEPTH = 10;
const VAR = /\{\{([^{}]+)\}\}/g;

// shortcut: small fixed word lists instead of faker, add faker if realistic variety matters
const words = (s: string) => s.split(' ');
const FIRST = words('James Mary John Patricia Robert Jennifer Michael Linda David Emma Oliver Sophia Lucas Mia Noah Ava');
const LAST = words('Smith Johnson Williams Brown Jones Garcia Miller Davis Wilson Taylor Clark Lewis Walker Hall Young King');
const LOREM = words('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua');
const WORDS = words('apple river stone cloud bridge forest copper silver garden window rocket planet signal harbor meadow engine');
const CITIES = words('London Paris Berlin Madrid Rome Vienna Prague Warsaw Lisbon Dublin Oslo Helsinki');
const COUNTRIES = [['United Kingdom', 'GB'], ['France', 'FR'], ['Germany', 'DE'], ['Spain', 'ES'], ['Italy', 'IT'], ['Poland', 'PL'], ['Norway', 'NO'], ['Japan', 'JP'], ['Canada', 'CA'], ['Brazil', 'BR']];
const STREETS = words('Main Oak Pine Maple Cedar Elm Park Lake Hill Church');
const COMPANY = words('Group Inc LLC Ltd Partners Labs Systems');
const JOBS = ['Software Engineer', 'Product Manager', 'Data Analyst', 'Designer', 'Accountant', 'Sales Manager', 'Consultant', 'Architect'];
const CURRENCIES = words('USD EUR GBP PLN JPY CHF CAD AUD SEK NOK');
const LOCALES = words('en de fr es it pl pt ja zh nl sv');
const TLDS = words('com net org io info biz');
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const pick = <T>(a: T[]): T => a[randomInt(a.length)];
const hex = (bytes: number) => Array.from({ length: bytes }, () => randomInt(256).toString(16).padStart(2, '0'));
const alnum = (n: number) => Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join('');
const some = (a: string[], min: number, max: number) => Array.from({ length: randomInt(min, max + 1) }, () => pick(a)).join(' ');
const day = 86_400_000;
const date = (from: number, to: number) => new Date(Date.now() + randomInt(from, to)).toString();
const domain = () => `${pick(WORDS)}${pick(WORDS)}.${pick(TLDS)}`;
const user = () => `${pick(FIRST)}.${pick(LAST)}${randomInt(100)}`;

const dynamic: Record<string, () => string> = {
  $guid: randomUUID,
  $randomUUID: randomUUID,
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)), // 0-1000 inclusive, like Postman
  $randomAlphaNumeric: () => alnum(1),
  $randomBoolean: () => String(randomInt(2) === 1),
  $randomHexColor: () => `#${hex(3).join('')}`,
  $randomIP: () => Array.from({ length: 4 }, () => randomInt(256)).join('.'),
  $randomIPV6: () => Array.from({ length: 8 }, () => hex(2).join('')).join(':'),
  $randomMACAddress: () => hex(6).join(':'),
  $randomPassword: () => alnum(15),
  $randomLocale: () => pick(LOCALES),
  $randomFirstName: () => pick(FIRST),
  $randomLastName: () => pick(LAST),
  $randomFullName: () => `${pick(FIRST)} ${pick(LAST)}`,
  $randomUserName: user,
  $randomEmail: () => `${user()}@${domain()}`,
  $randomExampleEmail: () => `${user()}@example.${pick(['com', 'net', 'org'])}`,
  $randomUrl: () => `https://${domain()}`,
  $randomDomainName: domain,
  $randomWord: () => pick(WORDS),
  $randomWords: () => some(WORDS, 2, 5),
  $randomLoremWord: () => pick(LOREM),
  $randomLoremWords: () => some(LOREM, 3, 3),
  $randomLoremSentence: () => { const s = some(LOREM, 4, 10); return `${s[0].toUpperCase()}${s.slice(1)}.`; },
  $randomPhoneNumber: () => `${randomInt(200, 1000)}-${randomInt(200, 1000)}-${String(randomInt(10000)).padStart(4, '0')}`,
  $randomCity: () => pick(CITIES),
  $randomCountry: () => pick(COUNTRIES)[0],
  $randomCountryCode: () => pick(COUNTRIES)[1],
  $randomStreetAddress: () => `${randomInt(1, 10000)} ${pick(STREETS)} Street`,
  $randomCompanyName: () => `${pick(LAST)} ${pick(COMPANY)}`,
  $randomJobTitle: () => pick(JOBS),
  $randomPrice: () => (randomInt(100, 100000) / 100).toFixed(2),
  $randomCurrencyCode: () => pick(CURRENCIES),
  $randomDatePast: () => date(-365 * day, -day),
  $randomDateFuture: () => date(day, 365 * day),
  $randomDateRecent: () => date(-day, 0),
};

export function getVar(s: Scopes, key: string): string | undefined {
  if (Object.hasOwn(s.runtime, key)) return s.runtime[key];
  for (const scope of [s.environment, s.collection, s.globals]) {
    const v = scope.find((x) => x.enabled && x.key === key);
    if (v) return v.value;
  }
  return undefined;
}

export function resolve(template: string, s: Scopes, depth = 1): string {
  return template.replace(VAR, (match, name: string) => {
    const value = Object.hasOwn(dynamic, name) ? dynamic[name]() : getVar(s, name);
    if (value === undefined) return match;
    return depth < MAX_DEPTH ? resolve(value, s, depth + 1) : value;
  });
}
