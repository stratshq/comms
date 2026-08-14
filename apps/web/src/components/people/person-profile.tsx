'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Ban,
  Check,
  Images,
  Mail,
  MessageSquare,
  Phone,
  Plus,
  Users,
  X,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  addContactIdentity,
  nameContact,
  removeContactIdentity,
  setContactAttribute,
  setContactOptOut,
  updateContactDetails,
} from '@/server/actions/contacts';
import { localTimeForAddress } from '@/lib/area-code-time';
import { conversationName, formatAddress } from '@/lib/naming';
import { listTime, relativeTime } from '@/lib/format';
import { cn, initials } from '@/lib/utils';

export interface PersonProfileData {
  contact: {
    id: string;
    displayName: string | null;
    company: string | null;
    notes: string | null;
    avatarUrl: string | null;
    attributes: Record<string, string>;
    optedOut: boolean;
    syncedAt: string | null;
  };
  identities: { id: string; kind: string; value: string; rawValue: string | null }[];
  conversations: {
    id: string;
    title: string | null;
    isGroup: boolean;
    status: string;
    unreadCount: number;
    lastMessageAt: string | null;
    lastMessagePreview: string | null;
    providerChatGuid: string;
    inbox: { name: string; color: string } | null;
  }[];
  stats: {
    totalMessages: number;
    inbound: number;
    outbound: number;
    firstMessageAt: string | null;
    lastInboundAt: string | null;
  };
  photos: { id: string; fileName: string | null }[];
  photoCount: number;
}

/**
 * One person, everything about them.
 *
 * Reachable only by clicking their face — never from the nav. A "Contacts"
 * nav entry would imply a directory you go and browse, which is not what this
 * is for: you arrive here from a conversation, with a question about the
 * person you were just reading.
 */
export function PersonProfile({ data }: { data: PersonProfileData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const c = data.contact;

  const [name, setName] = useState(c.displayName ?? '');
  const [company, setCompany] = useState(c.company ?? '');
  const [notes, setNotes] = useState(c.notes ?? '');
  const [optedOut, setOptedOut] = useState(c.optedOut);
  const [newAddress, setNewAddress] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [fieldValue, setFieldValue] = useState('');

  const displayName = c.displayName?.trim() || formatAddress(primaryAddress(data)) || 'Unknown';
  const local = localTimeForAddress(primaryAddress(data));

  function save<T>(run: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) {
    start(async () => {
      const res = await run();
      if (!res.ok) {
        toast.error(res.error ?? 'Something went wrong');
        return;
      }
      onOk?.();
      router.refresh();
    });
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-10">
      <Link
        href="/inbox"
        className="mb-5 inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to the inbox
      </Link>

      {/* ---- Identity header ------------------------------------------- */}
      <div className="flex items-start gap-4">
        <Avatar className="h-16 w-16 ring-1 ring-border">
          {c.avatarUrl && <AvatarImage src={c.avatarUrl} alt={displayName} />}
          <AvatarFallback className="bg-secondary text-lg font-semibold text-muted-foreground">
            {initials(displayName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-[-0.01em]">{displayName}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-muted-foreground">
            {c.company && <span>{c.company}</span>}
            {local && (
              <span className={cn(local.unsociable && 'text-warning')}>
                {local.time} their time
              </span>
            )}
            {c.syncedAt && <span>synced {relativeTime(c.syncedAt)}</span>}
          </p>
          {optedOut && (
            <Badge variant="soft-danger" size="sm" className="mt-2 gap-1">
              <Ban className="h-3 w-3" />
              Opted out — sends are blocked
            </Badge>
          )}
        </div>
      </div>

      {/* ---- Relationship at a glance ----------------------------------- */}
      <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border bg-surface p-4 sm:grid-cols-4">
        <Stat label="Messages" value={data.stats.totalMessages.toLocaleString()} />
        <Stat
          label="They sent"
          value={data.stats.inbound.toLocaleString()}
        />
        <Stat
          label="Last heard from"
          value={data.stats.lastInboundAt ? relativeTime(data.stats.lastInboundAt) : '—'}
        />
        <Stat
          label="Talking since"
          value={data.stats.firstMessageAt ? relativeTime(data.stats.firstMessageAt) : '—'}
        />
      </dl>

      {/* ---- Their threads ----------------------------------------------- */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">
            Conversations
            <span className="ml-2 text-[12px] font-normal text-muted-foreground">
              {data.conversations.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {data.conversations.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No threads yet. They exist as a contact, but nobody has texted them.
            </p>
          ) : (
            data.conversations.map((conv) => (
              <Link
                key={conv.id}
                href={`/inbox/${conv.id}`}
                className="-mx-2 flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-accent"
              >
                <span className="mt-0.5 shrink-0 text-muted-foreground/70">
                  {conv.isGroup ? (
                    <Users className="h-3.5 w-3.5" />
                  ) : (
                    <MessageSquare className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">
                      {conversationName({
                        contactName: conv.isGroup ? null : c.displayName,
                        title: conv.title,
                        chatGuid: conv.providerChatGuid,
                        isGroup: conv.isGroup,
                      })}
                    </span>
                    {conv.unreadCount > 0 && (
                      <Badge variant="brand" size="sm" className="tabular">
                        {conv.unreadCount}
                      </Badge>
                    )}
                    {conv.status !== 'open' && (
                      <Badge variant="outline" size="sm" className="capitalize">
                        {conv.status}
                      </Badge>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                    {conv.lastMessagePreview || 'No messages yet'}
                  </span>
                </span>
                <span className="tabular shrink-0 text-[11.5px] text-muted-foreground/80">
                  {conv.lastMessageAt ? listTime(conv.lastMessageAt) : ''}
                </span>
              </Link>
            ))
          )}
        </CardContent>
      </Card>

      {/* ---- Profile ------------------------------------------------------ */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="person-name">Name</Label>
              <Input
                id="person-name"
                value={name}
                disabled={pending}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  const next = name.trim();
                  if (!next || next === (c.displayName ?? '')) return;
                  save(() => nameContact({ contactId: c.id, name: next }));
                }}
                placeholder="Their name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="person-company">Company</Label>
              <Input
                id="person-company"
                value={company}
                disabled={pending}
                onChange={(e) => setCompany(e.target.value)}
                onBlur={() => {
                  if (company.trim() === (c.company ?? '')) return;
                  save(() => updateContactDetails({ contactId: c.id, company }));
                }}
                placeholder="Where they work"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="person-notes">Notes</Label>
            <Textarea
              id="person-notes"
              value={notes}
              disabled={pending}
              rows={3}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => {
                if (notes.trim() === (c.notes ?? '')) return;
                save(() => updateContactDetails({ contactId: c.id, notes }));
              }}
              placeholder="Anything worth remembering before you reply."
            />
          </div>

          <div className="flex items-center justify-between gap-4 border-t pt-4">
            <div>
              <p className="text-sm font-medium">Opted out</p>
              <p className="text-xs text-muted-foreground">
                Blocks every outbound message to them, including automations. Set automatically
                when someone replies STOP.
              </p>
            </div>
            <Switch
              checked={optedOut}
              disabled={pending}
              onCheckedChange={(v) => {
                setOptedOut(v);
                save(
                  () => setContactOptOut({ contactId: c.id, optedOut: v }),
                  () => toast.success(v ? 'Sends to them are blocked' : 'Sends re-enabled'),
                );
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* ---- Addresses ----------------------------------------------------- */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Addresses</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Every number and email that reaches this person. Adding one here merges their history
            — the same human texting from two numbers stops being two strangers.
          </p>
          {data.identities.map((i) => (
            <div key={i.id} className="group flex items-center gap-2.5">
              {i.kind === 'email' ? (
                <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
              ) : (
                <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
              )}
              <span className="flex-1 truncate text-[13px]">
                {formatAddress(i.rawValue ?? i.value) ?? i.value}
              </span>
              {data.identities.length > 1 && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    save(() => removeContactIdentity({ contactId: c.id, identityId: i.id }))
                  }
                  aria-label={`Remove ${i.value}`}
                  className="rounded p-1 text-muted-foreground/50 opacity-0 transition-all hover:bg-accent hover:text-destructive group-hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
          <form
            className="flex gap-2 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newAddress.trim()) return;
              save(
                () => addContactIdentity({ contactId: c.id, address: newAddress }),
                () => setNewAddress(''),
              );
            }}
          >
            <Input
              value={newAddress}
              disabled={pending}
              onChange={(e) => setNewAddress(e.target.value)}
              placeholder="+1 555 123 4567 or them@work.com"
              className="h-8 text-[12.5px]"
            />
            <Button type="submit" size="sm" variant="outline" disabled={pending || !newAddress.trim()}>
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* ---- Custom fields ------------------------------------------------- */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Custom fields</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {Object.entries(c.attributes).length === 0 && (
            <p className="text-xs text-muted-foreground">
              Anything you want to track about them — plan, renewal date, who owns the account.
            </p>
          )}
          {Object.entries(c.attributes).map(([k, v]) => (
            <div key={k} className="group flex items-center gap-2.5">
              <span className="w-32 shrink-0 truncate text-[12px] text-muted-foreground">{k}</span>
              <span className="flex-1 truncate text-[13px]">{v}</span>
              <button
                type="button"
                disabled={pending}
                onClick={() => save(() => setContactAttribute({ contactId: c.id, key: k, value: '' }))}
                aria-label={`Remove ${k}`}
                className="rounded p-1 text-muted-foreground/50 opacity-0 transition-all hover:bg-accent hover:text-destructive group-hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <form
            className="flex gap-2 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (!fieldKey.trim() || !fieldValue.trim()) return;
              save(
                () => setContactAttribute({ contactId: c.id, key: fieldKey, value: fieldValue }),
                () => {
                  setFieldKey('');
                  setFieldValue('');
                },
              );
            }}
          >
            <Input
              value={fieldKey}
              disabled={pending}
              onChange={(e) => setFieldKey(e.target.value)}
              placeholder="Field"
              className="h-8 w-32 shrink-0 text-[12.5px]"
            />
            <Input
              value={fieldValue}
              disabled={pending}
              onChange={(e) => setFieldValue(e.target.value)}
              placeholder="Value"
              className="h-8 text-[12.5px]"
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={pending || !fieldKey.trim() || !fieldValue.trim()}
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* ---- Photos -------------------------------------------------------- */}
      {data.photos.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Images className="h-4 w-4 text-muted-foreground" />
              Photos
              <span className="text-[12px] font-normal text-muted-foreground">
                {data.photoCount}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
              {data.photos.map((a) => (
                <Link
                  key={a.id}
                  href={`/api/attachments/${a.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="group relative aspect-square overflow-hidden rounded-lg border"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/attachments/${a.id}`}
                    alt={a.fileName ?? 'Shared photo'}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-300 ease-smooth group-hover:scale-105"
                  />
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function primaryAddress(data: PersonProfileData): string {
  const first = data.identities[0];
  return first?.rawValue ?? first?.value ?? '';
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11.5px] text-muted-foreground/70">{label}</dt>
      <dd className="mt-px truncate text-[14px] font-medium">{value}</dd>
    </div>
  );
}
