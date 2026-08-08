import { describe, it, expect } from 'vitest';
import { describeTime, parseNaturalTime } from '../src/lib/parse-time';

/** Wednesday 12 March 2025, 15:00 local. Mid-week and mid-afternoon so that
 *  "next weekday" and "already passed today" cases are both exercised. */
const NOW = new Date(2025, 2, 12, 15, 0, 0, 0);

const parse = (s: string) => parseNaturalTime(s, NOW);

describe('relative offsets', () => {
  it('parses "in N unit" and the bare shorthand', () => {
    expect(parse('in 3 hours')?.getTime()).toBe(NOW.getTime() + 3 * 3_600_000);
    expect(parse('3h')?.getTime()).toBe(NOW.getTime() + 3 * 3_600_000);
    expect(parse('in 45m')?.getTime()).toBe(NOW.getTime() + 45 * 60_000);
    expect(parse('2 weeks')?.getTime()).toBe(NOW.getTime() + 14 * 86_400_000);
  });

  it('rejects a zero or unknown unit rather than guessing', () => {
    expect(parse('in 0 hours')).toBeNull();
    expect(parse('in 5 bananas')).toBeNull();
  });
});

describe('times of day', () => {
  it('reads a meridiem', () => {
    const d = parse('9am')!;
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it('rolls a time that already passed today into tomorrow', () => {
    // 9am typed at 3pm means tomorrow, the way every mail client behaves.
    const d = parse('9am')!;
    expect(d.getDate()).toBe(13);
  });

  it('keeps a time still ahead on today', () => {
    const d = parse('6pm')!;
    expect(d.getDate()).toBe(12);
    expect(d.getHours()).toBe(18);
  });

  it('handles minutes with either separator', () => {
    expect(parse('9:30am')?.getMinutes()).toBe(30);
    expect(parse('9.30am')?.getMinutes()).toBe(30);
  });

  it('reads a bare small hour as the afternoon', () => {
    // Nobody schedules a text for 3am.
    expect(parse('at 3')?.getHours()).toBe(15);
  });

  it('handles the 12am/12pm corner', () => {
    expect(parse('12am')?.getHours()).toBe(0);
    expect(parse('12pm')?.getHours()).toBe(12);
  });

  it('understands noon and midnight', () => {
    expect(parse('noon')?.getHours()).toBe(12);
    expect(parse('midnight')?.getHours()).toBe(0);
  });

  it('rejects impossible clock values', () => {
    expect(parse('99:99')).toBeNull();
  });
});

describe('days', () => {
  it('parses tomorrow, defaulting to 9am', () => {
    const d = parse('tomorrow')!;
    expect(d.getDate()).toBe(13);
    expect(d.getHours()).toBe(9);
  });

  it('parses tomorrow with a time', () => {
    const d = parse('tomorrow 2pm')!;
    expect(d.getDate()).toBe(13);
    expect(d.getHours()).toBe(14);
  });

  it('parses a weekday and its abbreviations', () => {
    // NOW is Wednesday; Friday is 2 days out.
    for (const s of ['friday', 'fri', 'fri 9am']) {
      expect(parse(s)?.getDate(), s).toBe(14);
    }
  });

  it('reads a bare weekday as NEXT week when it is today', () => {
    // Naming today's weekday and getting a time five hours ago is never meant.
    const d = parse('wednesday')!;
    expect(d.getDate()).toBe(19);
  });

  it('parses tonight as the evening', () => {
    const d = parse('tonight')!;
    expect(d.getDate()).toBe(12);
    expect(d.getHours()).toBe(20);
  });

  it('refuses a "today" time that has already passed', () => {
    // Rolling it to tomorrow would silently contradict the word "today".
    expect(parse('today 9am')).toBeNull();
  });
});

describe('calendar dates', () => {
  it('parses a month and day in either order', () => {
    expect(parse('mar 20')?.getDate()).toBe(20);
    expect(parse('20 march')?.getDate()).toBe(20);
  });

  it('carries a time alongside the date', () => {
    const d = parse('march 20 2pm')!;
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(20);
    expect(d.getHours()).toBe(14);
  });

  it('rolls a date already past into next year', () => {
    const d = parse('jan 5')!;
    expect(d.getFullYear()).toBe(2026);
  });
});

describe('regressions found in review', () => {
  it('does not read a year as a clock time', () => {
    // "2025" matched \d{1,2} + \d{2} and became 20:25.
    const d = parse('mar 4 2026')!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(9); // the default, not 20
  });

  it('does not read the minutes of a clock time as the day of the month', () => {
    // "mar 9:30" rejected the 9 for having a colon, then took the 30 as a day.
    const d = parse('mar 9:30am')!;
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
    expect(d.getDate()).not.toBe(30);
  });

  it('does not resolve prototype keys as weekdays or units', () => {
    // 'constructor' in WEEKDAYS was true, producing an Invalid Date that threw
    // downstream in toISOString().
    for (const s of ['constructor', 'toString', 'in 5 constructor', '__proto__']) {
      const d = parse(s);
      expect(d === null || !Number.isNaN(d.getTime()), s).toBe(true);
    }
  });

  it('never returns an Invalid Date for any input', () => {
    const inputs = ['constructor', 'valueOf', 'in 3 hasOwnProperty', 'mar 99', 'feb 30 2026'];
    for (const s of inputs) {
      const d = parse(s);
      if (d) expect(Number.isNaN(d.getTime()), s).toBe(false);
    }
  });
});

describe('refusing to guess', () => {
  it('returns null for junk rather than a plausible wrong time', () => {
    // A wrong snooze time is worse than being asked to pick one.
    for (const s of ['', '   ', 'asdf', 'sometime soon', 'later']) {
      expect(parse(s), s).toBeNull();
    }
  });

  it('never returns a time in the past', () => {
    const inputs = ['9am', 'tomorrow', 'friday', 'mar 20', 'in 1 hour', 'noon', 'wednesday'];
    for (const s of inputs) {
      const d = parse(s);
      if (d) expect(d.getTime(), s).toBeGreaterThan(NOW.getTime());
    }
  });
});

describe('describeTime', () => {
  it('names today and tomorrow rather than repeating the date', () => {
    expect(describeTime(new Date(2025, 2, 12, 18, 0), NOW)).toMatch(/^Today, /);
    expect(describeTime(new Date(2025, 2, 13, 9, 0), NOW)).toMatch(/^Tomorrow, /);
  });

  it('uses the weekday within a week and a date beyond it', () => {
    expect(describeTime(new Date(2025, 2, 14, 9, 0), NOW)).toMatch(/^Friday, /);
    expect(describeTime(new Date(2025, 3, 20, 9, 0), NOW)).not.toMatch(/day, /);
  });
});
