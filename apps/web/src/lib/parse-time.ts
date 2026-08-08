/**
 * Natural-language times: "tue 9am", "in 3 hours", "tomorrow", "mar 4 2pm".
 *
 * Deliberately hand-written rather than pulled from a date library. The input
 * space people actually type into a snooze box is small and boring, a parser
 * for it is a hundred lines, and every general-purpose NL date library is an
 * order of magnitude larger than the whole feature.
 *
 * The rules that matter:
 *  - Never return a time in the past. "9am" typed at 3pm means tomorrow 9am,
 *    which is what every mail client does and what people expect.
 *  - A bare weekday means the NEXT one. "tuesday" typed on a Tuesday means the
 *    following week, not five minutes ago.
 *  - A bare hour with no meridiem is read the way a human would: 1–7 is
 *    afternoon, 8–12 is morning.
 *  - Ambiguity returns null rather than a guess. A wrong snooze time is worse
 *    than being asked to pick.
 */

const WEEKDAYS: Record<string, number> = Object.assign(Object.create(null), {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
});

const MONTHS: Record<string, number> = Object.assign(Object.create(null), {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
});

const UNIT_MS: Record<string, number> = Object.assign(Object.create(null), {
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
});

/** Default hour when a day is named without a time. */
const DEFAULT_HOUR = 9;

/** Words that carry no meaning here and would otherwise block a match. */
const FILLER = new Set(['at', 'on', 'this', 'next', 'the', 'by', 'around', 'about', 'me']);

interface TimeOfDay {
  hour: number;
  minute: number;
}

/**
 * Pull a time out of the text and return it with the time removed, so the
 * caller can then look at what day was meant.
 */
function extractTime(input: string): { time: TimeOfDay | null; rest: string } {
  // 9am / 9:30am / 9.30pm / 14:00 / noon / midnight
  const named = input.match(/\b(noon|midday|midnight)\b/);
  if (named) {
    const hour = named[1] === 'midnight' ? 0 : 12;
    return { time: { hour, minute: 0 }, rest: input.replace(named[0], ' ') };
  }

  // The trailing (?!\d) matters: without it a bare year like "2025" matches as
  // 20:25, so "mar 4 2025" silently became 8:25pm.
  const m = input.match(/\b(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)?\b(?!\d)/);
  if (!m) return { time: null, rest: input };

  // A bare 1- or 2-digit number with no meridiem and no colon is only a time if
  // nothing else claims it — "in 3 hours" and "mar 4" must not be read as 3:00
  // and 4:00. Those callers strip their number before reaching here.
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3];

  if (hour > 23 || minute > 59) return { time: null, rest: input };

  if (meridiem === 'am') {
    if (hour === 12) hour = 0;
  } else if (meridiem === 'pm') {
    if (hour !== 12) hour += 12;
  } else if (!m[2] && hour <= 7) {
    // "at 3" means the afternoon. Nobody schedules a text for 3am.
    hour += 12;
  }

  return { time: { hour, minute }, rest: input.replace(m[0], ' ') };
}

function atTime(base: Date, time: TimeOfDay | null): Date {
  const d = new Date(base);
  d.setHours(time?.hour ?? DEFAULT_HOUR, time?.minute ?? 0, 0, 0);
  return d;
}

/**
 * Parse a human time expression into a Date, or null when it isn't one.
 *
 * `now` is injectable so the behaviour is testable without freezing the clock.
 */
export function parseNaturalTime(input: string, now: Date = new Date()): Date | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  // "in 3 hours" / "3h" / "in 45m" / "2 weeks".
  // An unrecognised unit falls THROUGH rather than failing: "9am" matches this
  // shape too, and returning null here would make the most common input of all
  // unparseable.
  const rel = raw.match(/^(?:in\s+)?(\d+)\s*([a-z]+)$/);
  if (rel) {
    const amount = Number(rel[1]);
    const ms = UNIT_MS[rel[2]!];
    if (ms && amount > 0) return new Date(now.getTime() + amount * ms);
    if (ms) return null; // a real unit with a zero amount is a mistake
  }

  // A calendar date is pulled out BEFORE the time, because the day number and
  // the hour look identical to a regex — in "mar 20" the time matcher would
  // otherwise claim the 20 and leave the month with no day.
  let working = raw;
  let monthIdx: number | null = null;
  let dayNum: number | null = null;
  let yearNum: number | null = null;
  const monthWord = working.match(/\b[a-z]{3,9}\b/g)?.find((w) => Object.hasOwn(MONTHS, w));
  if (monthWord) {
    monthIdx = MONTHS[monthWord]!;
    // Pull an explicit year out before anything else can claim those digits.
    const yearMatch = working.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
      yearNum = Number(yearMatch[0]);
      working = working.replace(yearMatch[0], ' ');
    }
    working = working.replace(new RegExp(`\\b${monthWord}\\b`), ' ');
    // A number is the day only if no meridiem or clock separator claims it.
    // The lookbehind stops the MINUTES of a clock time being read as the day:
    // in "mar 9:30" the 9 is rejected for having a colon after it, and without
    // this the 30 would then be accepted as the day of the month.
    const dayMatch = working.match(/(?<![:.\d])\b(\d{1,2})\b(?!\s*(?:am|pm)|[:.]\d)/);
    if (dayMatch) {
      dayNum = Number(dayMatch[1]);
      working = working.replace(dayMatch[0], ' ');
    }
  }

  const { time, rest } = extractTime(working);
  const words = rest.split(/[\s,]+/).filter((w) => w && !FILLER.has(w));
  const hasWord = (w: string) => words.includes(w);

  if (monthIdx !== null && dayNum !== null) {
    // Built from parts rather than mutated, so setting February on the 31st
    // cannot roll into March.
    const at = new Date(yearNum ?? now.getFullYear(), monthIdx, dayNum);
    const result = atTime(at, time);
    // A date that has already passed means next year — but only when the year
    // was inferred. An explicit "mar 4 2024" is a mistake, not next March.
    if (yearNum === null && result.getTime() <= now.getTime()) {
      result.setFullYear(result.getFullYear() + 1);
    }
    return result;
  }

  if (hasWord('today') || hasWord('tonight')) {
    const d = atTime(now, time ?? (hasWord('tonight') ? { hour: 20, minute: 0 } : null));
    // "today" with an hour that has already passed is a mistake, not tomorrow.
    return d.getTime() > now.getTime() ? d : null;
  }

  if (hasWord('tomorrow') || hasWord('tmr') || hasWord('tmrw')) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return atTime(d, time);
  }

  const dayWord = words.find((w) => Object.hasOwn(WEEKDAYS, w));
  if (dayWord) {
    const target = WEEKDAYS[dayWord]!;
    const d = new Date(now);
    // A bare weekday always means the NEXT one — naming today's weekday and
    // getting a time that already passed is never what anyone meant.
    const delta = (target - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + delta);
    return atTime(d, time);
  }

  // A bare time with no day: today if it's still ahead, otherwise tomorrow.
  if (time && words.length === 0) {
    const todayAt = atTime(now, time);
    if (todayAt.getTime() > now.getTime()) return todayAt;
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return atTime(d, time);
  }

  return null;
}

/** Short confirmation of a parsed time, e.g. "Tue 9:00 AM". */
export function describeTime(date: Date, now: Date = new Date()): string {
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  if (isTomorrow) return `Tomorrow, ${time}`;

  const withinAWeek = date.getTime() - now.getTime() < 7 * 86_400_000;
  const day = withinAWeek
    ? date.toLocaleDateString(undefined, { weekday: 'long' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day}, ${time}`;
}
