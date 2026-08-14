'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  FlaskConical,
  Check,
  X,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  createRule,
  deleteRule,
  toggleRule,
  reorderRule,
  dryRunRules,
  type RuleActions,
  type RuleConditions,
  type DryRunResult,
} from '@/server/actions/automations';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: 'conversation_created' | 'message_received';
  conditions: RuleConditions;
  actions: RuleActions;
  stopProcessing: boolean;
  fireCount: number;
  lastFiredAt: Date | string | null;
  lastConversationNumber: number | null;
};

const NO_CHANGE = '__none__';
const UNASSIGNED = '__unassigned__';
const ANY = '__any__';

/** Human-readable one-liner describing what a rule does. */
function describeRule(
  r: Rule,
  agents: { id: string; name: string | null; email: string }[],
  allTags: { id: string; name: string }[],
): string {
  const conds: string[] = [];
  if (r.conditions.bodyContains?.length)
    conds.push(`contains "${r.conditions.bodyContains.join('", "')}"`);
  if (r.conditions.priorityIn?.length) conds.push(`priority ${r.conditions.priorityIn.join('/')}`);
  if (r.conditions.kindIn?.length) conds.push(`from ${r.conditions.kindIn.join('/')}`);
  if (r.conditions.contactIs)
    conds.push(r.conditions.contactIs === 'first_time' ? 'first-time contact' : 'returning contact');
  if (r.conditions.businessHours)
    conds.push(`${r.conditions.businessHours} business hours`);
  if (r.conditions.hasTagIds?.length) {
    const names = r.conditions.hasTagIds
      .map((id) => allTags.find((t) => t.id === id)?.name)
      .filter(Boolean);
    if (names.length) conds.push(`tagged ${names.join(', ')}`);
  }

  const acts: string[] = [];
  if (r.actions.setStatus) acts.push(`set ${r.actions.setStatus}`);
  if (r.actions.setPriority) acts.push(`priority ${r.actions.setPriority}`);
  if (r.actions.assignToUserId) {
    const a = agents.find((x) => x.id === r.actions.assignToUserId);
    acts.push(`assign ${a?.name ?? a?.email ?? 'agent'}`);
  }
  if (r.actions.addTagIds?.length) acts.push(`tag ${r.actions.addTagIds.length}`);
  if (r.actions.autoReply) acts.push('auto-reply');
  if (r.actions.mute) acts.push('mute');
  if (r.actions.snoozeMinutes) acts.push(`snooze ${r.actions.snoozeMinutes}m`);
  if (r.actions.slaMinutes) acts.push(`SLA ${r.actions.slaMinutes}m`);

  return `${conds.length ? `When ${conds.join(' and ')}` : 'Always'} → ${acts.join(', ') || 'nothing'}`;
}

export function AutomationManager({
  rules,
  agents,
  allTags,
  inboxes,
}: {
  rules: Rule[];
  agents: { id: string; name: string | null; email: string }[];
  allTags: { id: string; name: string; color: string }[];
  inboxes: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [showForm, setShowForm] = useState(false);

  // Rule builder state
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<'conversation_created' | 'message_received'>(
    'conversation_created',
  );
  const [keywords, setKeywords] = useState('');
  const [condInbox, setCondInbox] = useState(ANY);
  const [condPriority, setCondPriority] = useState(ANY);
  const [condContact, setCondContact] = useState(ANY);
  const [condHours, setCondHours] = useState(ANY);
  const [condKind, setCondKind] = useState(ANY);
  const [setStatus, setSetStatus] = useState(NO_CHANGE);
  const [setPriority, setSetPriority] = useState(NO_CHANGE);
  const [assignee, setAssignee] = useState(NO_CHANGE);
  const [mute, setMute] = useState(false);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [autoReply, setAutoReply] = useState('');
  const [snoozeMinutes, setSnoozeMinutes] = useState('');
  const [slaMinutes, setSlaMinutes] = useState('');
  const [stopProcessing, setStopProcessing] = useState(false);

  // Dry-run tester
  const [testBody, setTestBody] = useState('');
  const [testResults, setTestResults] = useState<DryRunResult[] | null>(null);

  function reset() {
    setName('');
    setKeywords('');
    setCondInbox(ANY);
    setCondPriority(ANY);
    setCondContact(ANY);
    setCondHours(ANY);
    setCondKind(ANY);
    setSetStatus(NO_CHANGE);
    setSetPriority(NO_CHANGE);
    setAssignee(NO_CHANGE);
    setMute(false);
    setTagIds([]);
    setAutoReply('');
    setSnoozeMinutes('');
    setSlaMinutes('');
    setStopProcessing(false);
    setShowForm(false);
  }

  function submit() {
    const conditions: RuleConditions = {
      bodyContains: keywords.split(',').map((k) => k.trim()).filter(Boolean),
    };
    if (condInbox !== ANY) conditions.inboxId = condInbox;
    if (condPriority !== ANY) conditions.priorityIn = [condPriority as never];
    if (condContact !== ANY) conditions.contactIs = condContact as never;
    if (condHours !== ANY) conditions.businessHours = condHours as never;
    if (condKind !== ANY) conditions.kindIn = [condKind as never];

    const actions: RuleActions = {};
    if (setStatus !== NO_CHANGE) actions.setStatus = setStatus as never;
    if (setPriority !== NO_CHANGE) actions.setPriority = setPriority as never;
    if (assignee !== NO_CHANGE) {
      actions.assignToUserId = assignee === UNASSIGNED ? null : assignee;
    }
    if (mute) actions.mute = true;
    if (tagIds.length) actions.addTagIds = tagIds;
    if (autoReply.trim()) actions.autoReply = autoReply.trim();
    if (snoozeMinutes) actions.snoozeMinutes = Number(snoozeMinutes);
    if (slaMinutes) actions.slaMinutes = Number(slaMinutes);

    if (Object.keys(actions).length === 0) {
      toast.error('Add at least one action.');
      return;
    }

    start(async () => {
      const res = await createRule({ name, trigger, conditions, actions, stopProcessing });
      if (res.ok) {
        toast.success('Rule created');
        reset();
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function runTest() {
    start(async () => {
      const results = await dryRunRules({ trigger, bodyText: testBody });
      setTestResults(results);
    });
  }

  return (
    <div className="space-y-5">
      {/* ---- Existing rules ---- */}
      <div className="space-y-2">
        {rules.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            No automations yet. Rules run top to bottom when a message arrives.
          </p>
        ) : (
          rules.map((r, i) => (
            <div key={r.id} className="rounded-xl border bg-surface p-3.5 shadow-xs">
              <div className="flex items-start gap-3">
                <Switch
                  checked={r.enabled}
                  onCheckedChange={(v) =>
                    start(async () => {
                      await toggleRule(r.id, v);
                      router.refresh();
                    })
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={cn('text-[13.5px] font-medium', !r.enabled && 'opacity-50')}>
                      {r.name}
                    </span>
                    <span className="rounded bg-secondary px-1.5 py-px text-[10.5px] text-muted-foreground">
                      {r.trigger === 'conversation_created' ? 'new conversation' : 'every message'}
                    </span>
                    {r.stopProcessing && (
                      <span className="rounded bg-secondary px-1.5 py-px text-[10.5px] text-muted-foreground">
                        stops chain
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                    {describeRule(r, agents, allTags)}
                  </p>
                  {/* Run log — a rule that fires invisibly is a rule nobody trusts. */}
                  <p className="mt-1 text-[11px] text-muted-foreground/80">
                    {r.fireCount > 0 ? (
                      <>
                        Fired <span className="tabular font-medium">{r.fireCount}</span>{' '}
                        {r.fireCount === 1 ? 'time' : 'times'}
                        {r.lastFiredAt && <> · last {relativeTime(r.lastFiredAt)}</>}
                        {r.lastConversationNumber && <> on #{r.lastConversationNumber}</>}
                      </>
                    ) : (
                      'Never fired yet'
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    disabled={i === 0}
                    onClick={() =>
                      start(async () => {
                        await reorderRule(r.id, 'up');
                        router.refresh();
                      })
                    }
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-25"
                    aria-label="Move up"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    disabled={i === rules.length - 1}
                    onClick={() =>
                      start(async () => {
                        await reorderRule(r.id, 'down');
                        router.refresh();
                      })
                    }
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-25"
                    aria-label="Move down"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() =>
                      start(async () => {
                        await deleteRule(r.id);
                        toast.success('Rule deleted');
                        router.refresh();
                      })
                    }
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                    aria-label="Delete rule"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ---- Dry-run tester ---- */}
      {rules.length > 0 && (
        <div className="rounded-xl border bg-surface-sunken p-3.5">
          <p className="flex items-center gap-1.5 text-[12.5px] font-medium">
            <FlaskConical className="h-3.5 w-3.5" />
            Test your rules
          </p>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            Paste a sample message to see which rules would fire. Nothing is sent or changed.
          </p>
          <div className="mt-2.5 flex gap-2">
            <Input
              value={testBody}
              onChange={(e) => setTestBody(e.target.value)}
              placeholder="e.g. I need a refund for my order"
              onKeyDown={(e) => {
                if (e.key === 'Enter') runTest();
              }}
            />
            <Button variant="outline" onClick={runTest} loading={pending} disabled={!testBody.trim()}>
              Test
            </Button>
          </div>
          {testResults && (
            <div className="mt-3 space-y-1">
              {testResults.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">
                  No enabled rules for this trigger.
                </p>
              ) : (
                testResults.map((r) => (
                  <div
                    key={r.ruleId}
                    className="flex items-start gap-2 rounded-lg bg-surface px-2.5 py-1.5 text-[12px]"
                  >
                    {r.matched ? (
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                    ) : (
                      <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                    )}
                    <span className={cn('font-medium', !r.matched && 'text-muted-foreground')}>
                      {r.ruleName}
                    </span>
                    <span className="ml-auto text-right text-[11px] text-muted-foreground">
                      {r.reason}
                      {r.stoppedChain && ' · stops chain'}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* ---- Builder ---- */}
      {!showForm ? (
        <Button variant="outline" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4" />
          New automation
        </Button>
      ) : (
        <div className="space-y-4 rounded-xl border bg-surface p-4 shadow-xs">
          <div className="space-y-1.5">
            <Label className="text-[12.5px]">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. After-hours auto-reply"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[12.5px]">Run on</Label>
            <Select value={trigger} onValueChange={(v) => setTrigger(v as never)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="conversation_created">A new conversation starts</SelectItem>
                <SelectItem value="message_received">Every inbound message</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Conditions */}
          <div className="space-y-3 rounded-lg border bg-surface-sunken p-3">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              When — all must match
            </p>
            <div className="space-y-1.5">
              <Label className="text-[12px]">Message contains (comma-separated, any match)</Label>
              <Input
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="refund, cancel, broken"
              />
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {inboxes.length > 1 && (
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Channel</Label>
                  <Select value={condInbox} onValueChange={setCondInbox}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Any channel</SelectItem>
                      {inboxes.map((i) => (
                        <SelectItem key={i.id} value={i.id}>
                          {i.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-[12px]">Priority is</Label>
                <Select value={condPriority} onValueChange={setCondPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any priority</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px]">Contact is</Label>
                <Select value={condContact} onValueChange={setCondContact}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Anyone</SelectItem>
                    <SelectItem value="first_time">First-time customer</SelectItem>
                    <SelectItem value="returning">Returning customer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px]">Time is</Label>
                <Select value={condHours} onValueChange={setCondHours}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any time</SelectItem>
                    <SelectItem value="inside">Inside business hours</SelectItem>
                    <SelectItem value="outside">Outside business hours</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px]">Sender is</Label>
                <Select value={condKind} onValueChange={setCondKind}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Anything</SelectItem>
                    <SelectItem value="person">A person</SelectItem>
                    <SelectItem value="unknown">An unknown number</SelectItem>
                    <SelectItem value="automated">Automated traffic</SelectItem>
                    <SelectItem value="otp">A verification code</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-3 rounded-lg border bg-surface-sunken p-3">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              Then
            </p>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-[12px]">Set status</Label>
                <Select value={setStatus} onValueChange={setSetStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_CHANGE}>No change</SelectItem>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px]">Set priority</Label>
                <Select value={setPriority} onValueChange={setSetPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_CHANGE}>No change</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px]">Assign to</Label>
                <Select value={assignee} onValueChange={setAssignee}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_CHANGE}>No change</SelectItem>
                    <SelectItem value={UNASSIGNED}>Unassign</SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name ?? a.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px]">Snooze for (minutes)</Label>
                <Input
                  type="number"
                  min={0}
                  value={snoozeMinutes}
                  onChange={(e) => setSnoozeMinutes(e.target.value)}
                  placeholder="—"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px]">Response SLA (minutes)</Label>
                <Input
                  type="number"
                  min={0}
                  value={slaMinutes}
                  onChange={(e) => setSlaMinutes(e.target.value)}
                  placeholder="—"
                />
              </div>
            </div>

            {allTags.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-[12px]">Add tags</Label>
                <div className="flex flex-wrap gap-1.5">
                  {allTags.map((t) => {
                    const on = tagIds.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() =>
                          setTagIds((prev) =>
                            on ? prev.filter((x) => x !== t.id) : [...prev, t.id],
                          )
                        }
                        className={cn(
                          'rounded-md border px-2 py-0.5 text-[11.5px] font-medium transition-all active:scale-95',
                          on ? 'border-transparent' : 'border-border text-muted-foreground',
                        )}
                        style={on ? { backgroundColor: `${t.color}20`, color: t.color } : undefined}
                      >
                        {t.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5 text-[12px]">
                <Zap className="h-3 w-3" />
                Auto-reply to the customer
              </Label>
              <Textarea
                value={autoReply}
                onChange={(e) => setAutoReply(e.target.value)}
                rows={2}
                placeholder="Thanks {{contact.first_name}} — we're closed right now and will reply first thing tomorrow."
                className="text-[13px]"
              />
              <p className="text-[11px] text-muted-foreground">
                Supports the same {'{{variables}}'} as macros. Sent at most once per hour per
                conversation, and never to a contact who replied STOP.
              </p>
            </div>
          </div>

          <label className="flex items-center gap-2 text-[12.5px]">
            <Switch checked={mute} onCheckedChange={setMute} />
            Mute the conversation — it stays in the list but never notifies
          </label>

          <label className="flex items-center gap-2 text-[12.5px]">
            <Switch checked={stopProcessing} onCheckedChange={setStopProcessing} />
            Stop processing further rules when this one matches
          </label>

          <div className="flex gap-2">
            <Button onClick={submit} loading={pending} disabled={!name.trim()}>
              Create automation
            </Button>
            <Button variant="ghost" onClick={reset} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
