'use client';

import { Plus, X } from 'lucide-react';
import {
  BOOLEAN_FIELDS,
  FIELD_CHOICES,
  FIELD_LABELS,
  QUERY_FIELDS,
  TEXT_FIELDS,
  operatorsFor,
  type FolderQuery,
  type QueryCondition,
  type QueryField,
  type QueryOperator,
} from '@comms/db/query';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const OPERATOR_LABELS: Record<QueryOperator, string> = {
  is: 'is',
  is_not: 'is not',
  contains: 'contains',
  not_contains: "doesn't contain",
};

/**
 * A row reads left to right as a sentence — "Priority is urgent", "Message
 * text contains refund" — because that is how someone describes the folder
 * they want before they open this. Every deviation from that reading order
 * costs a translation step at the moment they're least able to spare one.
 */
export function QueryBuilder({
  query,
  onChange,
  tags,
  inboxes,
  agents = [],
}: {
  query: FolderQuery;
  onChange: (q: FolderQuery) => void;
  tags: { id: string; name: string; color: string }[];
  inboxes: { id: string; name: string }[];
  agents?: { id: string; name: string | null; email: string }[];
}) {
  function patch(index: number, next: Partial<QueryCondition>) {
    onChange({
      ...query,
      conditions: query.conditions.map((c, i) => (i === index ? { ...c, ...next } : c)),
    });
  }

  /**
   * Changing the field resets the operator and the value. Carrying them over
   * produces rows like "Priority contains urgent" that look filled in and
   * evaluate to nothing — an empty value at least shows you it needs you.
   */
  function changeField(index: number, field: QueryField) {
    patch(index, {
      field,
      operator: operatorsFor(field)[0]!,
      value: BOOLEAN_FIELDS.includes(field) ? 'true' : '',
    });
  }

  function add() {
    onChange({
      ...query,
      conditions: [...query.conditions, { field: 'kind', operator: 'is', value: '' }],
    });
  }

  function remove(index: number) {
    onChange({ ...query, conditions: query.conditions.filter((_, i) => i !== index) });
  }

  function valueControl(c: QueryCondition, index: number) {
    const set = (value: string) => patch(index, { value });

    if (BOOLEAN_FIELDS.includes(c.field)) {
      return (
        <Select value={c.value || 'true'} onValueChange={set}>
          <SelectTrigger className="h-8 flex-1 text-[12.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">Yes</SelectItem>
            <SelectItem value="false">No</SelectItem>
          </SelectContent>
        </Select>
      );
    }

    if (TEXT_FIELDS.includes(c.field)) {
      return (
        <Input
          value={c.value}
          onChange={(e) => set(e.target.value)}
          placeholder="refund"
          className="h-8 flex-1 text-[12.5px]"
        />
      );
    }

    const options: { value: string; label: string }[] =
      c.field === 'tag'
        ? tags.map((t) => ({ value: t.id, label: t.name }))
        : c.field === 'inbox'
          ? inboxes.map((i) => ({ value: i.id, label: i.name }))
          : c.field === 'assignee'
            ? [
                { value: 'me', label: 'Me' },
                { value: 'unassigned', label: 'Nobody' },
                ...agents.map((a) => ({ value: a.id, label: a.name ?? a.email })),
              ]
            : (FIELD_CHOICES[c.field] ?? []).map((v) => ({ value: v, label: v }));

    if (options.length === 0) {
      // Nothing to pick means the condition can never be satisfied, and a
      // disabled empty select says that more plainly than a broken one.
      return (
        <div className="flex h-8 flex-1 items-center rounded-lg border px-2.5 text-[12.5px] text-muted-foreground">
          Nothing to choose
        </div>
      );
    }

    return (
      <Select value={c.value} onValueChange={set}>
        <SelectTrigger className="h-8 flex-1 text-[12.5px]">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="capitalize">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[12.5px] text-muted-foreground">Match</span>
        <Select
          value={query.match}
          onValueChange={(v) => onChange({ ...query, match: v as 'all' | 'any' })}
        >
          <SelectTrigger className="h-7 w-[74px] text-[12.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">all</SelectItem>
            <SelectItem value="any">any</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-[12.5px] text-muted-foreground">of these</span>
      </div>

      {query.conditions.map((c, i) => {
        const operators = operatorsFor(c.field);
        return (
          <div key={i} className="flex items-center gap-1.5">
            <Select value={c.field} onValueChange={(v) => changeField(i, v as QueryField)}>
              <SelectTrigger className="h-8 w-[122px] shrink-0 text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUERY_FIELDS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {FIELD_LABELS[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* A single-operator field ("Unread is …") prints the word rather
                than offering a menu with one entry in it. */}
            {operators.length > 1 ? (
              <Select
                value={c.operator}
                onValueChange={(v) => patch(i, { operator: v as QueryOperator })}
              >
                <SelectTrigger className="h-8 w-[104px] shrink-0 text-[12.5px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {operators.map((o) => (
                    <SelectItem key={o} value={o}>
                      {OPERATOR_LABELS[o]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="w-[104px] shrink-0 text-[12.5px] text-muted-foreground">
                {OPERATOR_LABELS[operators[0]!]}
              </span>
            )}

            {valueControl(c, i)}

            <button
              type="button"
              onClick={() => remove(i)}
              aria-label="Remove condition"
              className="shrink-0 rounded p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={add}
        className={cn(
          'flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-muted-foreground',
          'transition-colors hover:bg-accent hover:text-foreground',
        )}
      >
        <Plus className="h-3 w-3" />
        Add condition
      </button>
    </div>
  );
}
