/// <reference types="node" />
/**
 * Player profiles against a real Postgres with the production migrations applied
 * (plus scripts/local-auth-stub.sql standing in for Supabase's auth schema).
 *
 *   npm run db:local
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
 *
 * Every statement a player could send runs as the `authenticated` role with that player's JWT
 * claims, exactly as PostgREST runs it. Skipped when DATABASE_URL is not set.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql, type Tx } from '../../supabase/functions/game-action/db.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const PLAYER_ID = /^RR-[2-9A-HJ-NP-Z]{6}$/;
const cp = String.fromCodePoint;

interface ProfileJson {
  user_id: string;
  player_id: string;
  nickname: string;
  google_linked: boolean;
}
type RpcResult = { ok: true; created?: boolean; changed?: boolean; profile: ProfileJson } | { ok: false; code: string; retry_after_seconds?: number };

describe.skipIf(!DATABASE_URL)('player profiles (Postgres)', () => {
  let sql: Sql;

  beforeAll(() => {
    sql = createSql(DATABASE_URL!, 10);
  });

  afterAll(async () => {
    await sql?.end();
  });

  async function newUser(anonymous = true): Promise<string> {
    const [row] = await sql`insert into auth.users (is_anonymous) values (${anonymous}) returning id`;
    return row!.id as string;
  }

  /** Runs `fn` the way PostgREST runs a signed-in player's request. */
  function as<T>(userId: string | null, fn: (tx: Tx) => Promise<T>, role: 'authenticated' | 'anon' = 'authenticated'): Promise<T> {
    return sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${userId ? JSON.stringify({ sub: userId, role }) : ''}, true)`;
      await tx.unsafe(`set local role ${role}`);
      return fn(tx);
    }) as Promise<T>;
  }

  const initProfile = (userId: string | null) =>
    as(userId, async (tx) => {
      const [row] = await tx`select public.init_profile() as r`;
      return row!.r as RpcResult;
    });

  const updateNickname = (userId: string | null, nickname: string) =>
    as(userId, async (tx) => {
      const [row] = await tx`select public.update_nickname(${nickname}) as r`;
      return row!.r as RpcResult;
    });

  async function profileOf(userId: string): Promise<ProfileJson> {
    const res = await initProfile(userId);
    if (!res.ok) throw new Error(res.code);
    return res.profile;
  }

  describe('creation and ownership', () => {
    it('gives a new guest a Player ID and a default nickname, once', async () => {
      const user = await newUser();
      const first = await initProfile(user);
      expect(first).toMatchObject({ ok: true, created: true });
      if (!first.ok) return;
      expect(first.profile.user_id).toBe(user);
      expect(first.profile.player_id).toMatch(PLAYER_ID);
      expect(first.profile.nickname).toMatch(/^Player\d{4}$/);
      expect(first.profile.google_linked).toBe(false);

      // Any number of later launches or retries: the same profile, nothing new.
      for (let i = 0; i < 3; i += 1) {
        const again = await initProfile(user);
        expect(again).toMatchObject({ ok: true, created: false, profile: { player_id: first.profile.player_id, nickname: first.profile.nickname } });
      }
      const [count] = await sql`select count(*)::int as n from public.profiles where user_id = ${user}`;
      expect(count!.n).toBe(1);
    });

    it('simultaneous first requests create exactly one profile', async () => {
      const user = await newUser();
      const results = await Promise.all(Array.from({ length: 8 }, () => initProfile(user)));
      const ids = new Set(results.map((r) => (r.ok ? r.profile.player_id : r.code)));
      expect(ids.size).toBe(1);
      expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
      const [count] = await sql`select count(*)::int as n from public.profiles where user_id = ${user}`;
      expect(count!.n).toBe(1);
    });

    it('draws another Player ID when the first ones are taken', async () => {
      const taken = (await profileOf(await newUser())).player_id;
      const user = await newUser();
      const rollback = new Error('rollback');
      let drawn: RpcResult | null = null;
      await sql
        .begin(async (tx) => {
          // For this transaction only: the generator returns a taken ID twice, then a free one.
          // (A sequence, because it keeps counting across the function's internal retries.)
          await tx.unsafe('create sequence public.test_player_id_draws');
          await tx.unsafe(
            `create or replace function public.generate_player_id() returns text language plpgsql as $f$
             begin
               if nextval('public.test_player_id_draws') <= 2 then return '${taken}'; end if;
               return 'RR-ZZZZZ2';
             end $f$`,
          );
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user })}, true)`;
          await tx.unsafe('set local role authenticated');
          const [row] = await tx`select public.init_profile() as r`;
          drawn = row!.r as RpcResult;
          await tx.unsafe('reset role');
          const [draws] = await tx`select last_value::int as n from public.test_player_id_draws`;
          expect(draws!.n).toBe(3);
          throw rollback;
        })
        .catch((error) => {
          if (error !== rollback) throw error;
        });
      expect(drawn).toMatchObject({ ok: true, created: true, profile: { player_id: 'RR-ZZZZZ2' } });
      // Rolled back: the real generator is in place and nothing was kept.
      expect((await profileOf(user)).player_id).not.toBe('RR-ZZZZZ2');
    });

    it('generates well-formed, distinct Player IDs', async () => {
      const [row] = await sql`select array_agg(public.generate_player_id()) as ids from generate_series(1, 2000)`;
      const ids = row!.ids as string[];
      for (const id of ids) expect(id).toMatch(PLAYER_ID);
      // 2,000 draws from about a billion: a repeat would mean the generator is broken.
      expect(new Set(ids).size).toBeGreaterThanOrEqual(1998);
    });

    it('refuses a caller with no identity, and a token whose account is gone', async () => {
      expect(await initProfile(null)).toEqual({ ok: false, code: 'UNAUTHENTICATED' });
      expect(await updateNickname(null, 'Someone')).toEqual({ ok: false, code: 'UNAUTHENTICATED' });
      // A still-valid JWT of a deleted user: no profile can be created for it.
      expect(await initProfile(randomUUID())).toEqual({ ok: false, code: 'NO_USER' });
    });

    it('the anonymous (signed-out) role can call nothing', async () => {
      const user = await newUser();
      await expect(as(user, (tx) => tx`select public.init_profile()`, 'anon')).rejects.toThrow(/permission denied/);
      await expect(as(user, (tx) => tx`select public.update_nickname('Someone')`, 'anon')).rejects.toThrow(/permission denied/);
      await expect(as(user, (tx) => tx`select * from public.profiles`, 'anon')).rejects.toThrow(/permission denied/);
    });
  });

  describe('row level security', () => {
    it('a player reads only their own profile', async () => {
      const asha = await newUser();
      const bilal = await newUser();
      const ashaProfile = await profileOf(asha);
      await profileOf(bilal);

      const rows = await as(asha, (tx) => tx`select user_id, player_id, nickname from public.profiles`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: asha, player_id: ashaProfile.player_id });
      const others = await as(asha, (tx) => tx`select player_id from public.profiles where user_id = ${bilal}`);
      expect(others).toHaveLength(0);
    });

    it('a player cannot write the table at all — not even their own row', async () => {
      const asha = await newUser();
      const bilal = await newUser();
      await profileOf(asha);
      await profileOf(bilal);
      const denied = /permission denied/;
      await expect(as(asha, (tx) => tx`update public.profiles set nickname = 'Hacked' where user_id = ${bilal}`)).rejects.toThrow(denied);
      await expect(as(asha, (tx) => tx`update public.profiles set nickname = 'Mine' where user_id = ${asha}`)).rejects.toThrow(denied);
      await expect(as(asha, (tx) => tx`update public.profiles set player_id = 'RR-AAAAAA' where user_id = ${asha}`)).rejects.toThrow(denied);
      await expect(as(asha, (tx) => tx`update public.profiles set google_linked_at = now() where user_id = ${asha}`)).rejects.toThrow(denied);
      await expect(as(asha, (tx) => tx`delete from public.profiles where user_id = ${bilal}`)).rejects.toThrow(denied);
      await expect(as(asha, (tx) => tx`insert into public.profiles (user_id, player_id, nickname) values (${randomUUID()}, 'RR-AAAAAA', 'Fake')`)).rejects.toThrow(denied);
    });

    it('server-only data and helpers are out of reach', async () => {
      const asha = await newUser();
      await profileOf(asha);
      const denied = /permission denied/;
      await expect(as(asha, (tx) => tx`select nickname_changes from public.profiles`)).rejects.toThrow(denied);
      await expect(as(asha, (tx) => tx`select * from public.nickname_blocklist`)).rejects.toThrow(denied);
      await expect(as(asha, (tx) => tx`select public.generate_player_id()`)).rejects.toThrow(denied);
      await expect(as(asha, (tx) => tx`select * from auth.identities`)).rejects.toThrow(denied);
    });

    it('the Player ID and owner are immutable even for the server', async () => {
      const asha = await newUser();
      const other = await newUser();
      const profile = await profileOf(asha);
      await expect(sql`update public.profiles set player_id = 'RR-AAAAAA' where user_id = ${asha}`).rejects.toThrow(/immutable/);
      await expect(sql`update public.profiles set user_id = ${other} where user_id = ${asha}`).rejects.toThrow(/immutable/);
      await expect(sql`insert into public.profiles (user_id, player_id, nickname) values (${other}, 'RR-00OI11', 'Bad id')`).rejects.toThrow(/profiles_player_id_format/);
      await expect(sql`insert into public.profiles (user_id, player_id, nickname) values (${other}, ${profile.player_id}, 'Copycat')`).rejects.toThrow(/profiles_player_id_key/);
      expect((await profileOf(asha)).player_id).toBe(profile.player_id);
    });
  });

  describe('nickname changes', () => {
    it('normalises and saves, for the caller only', async () => {
      const asha = await newUser();
      const bilal = await newUser();
      const before = await profileOf(asha);
      const bilalBefore = await profileOf(bilal);

      const saved = await updateNickname(asha, `  Asha${cp(0xa0)}${cp(0xa0)}  Rao `);
      expect(saved).toMatchObject({ ok: true, changed: true, profile: { nickname: 'Asha Rao', player_id: before.player_id } });
      expect((await profileOf(asha)).nickname).toBe('Asha Rao');
      expect((await profileOf(bilal)).nickname).toBe(bilalBefore.nickname);

      // Unicode: stored as NFC, counted in characters.
      const unicode = await updateNickname(asha, `Jose${cp(0x301)} ${cp(0x1f3b2)}`);
      expect(unicode).toMatchObject({ ok: true, profile: { nickname: `Jos${cp(0xe9)} ${cp(0x1f3b2)}` } });
      expect(await updateNickname(asha, cp(0x924, 0x928, 0x94d, 0x92e, 0x92f))).toMatchObject({ ok: true });
    });

    it('nicknames do not have to be unique', async () => {
      const a = await newUser();
      const b = await newUser();
      await profileOf(a);
      await profileOf(b);
      expect(await updateNickname(a, 'Twin')).toMatchObject({ ok: true });
      expect(await updateNickname(b, 'Twin')).toMatchObject({ ok: true });
    });

    it('rejects invalid nicknames and keeps the old one', async () => {
      const user = await newUser();
      const before = await profileOf(user);
      const cases: [string, string][] = [
        ['', 'NICKNAME_EMPTY'],
        [`  ${cp(0xa0)} `, 'NICKNAME_EMPTY'],
        ['ab', 'NICKNAME_TOO_SHORT'],
        ['a b', 'NICKNAME_TOO_SHORT'],
        ['a'.repeat(21), 'NICKNAME_TOO_LONG'],
        [`As${cp(0x200b)}ha`, 'NICKNAME_INVALID_CHARACTERS'],
        [`Asha${cp(0x202e)}`, 'NICKNAME_INVALID_CHARACTERS'],
        [`As${cp(0x7)}ha`, 'NICKNAME_INVALID_CHARACTERS'],
      ];
      for (const [nickname, code] of cases) expect(await updateNickname(user, nickname)).toEqual({ ok: false, code });
      expect((await profileOf(user)).nickname).toBe(before.nickname);
    });

    it('applies the moderation list without catching ordinary names', async () => {
      const user = await newUser();
      await profileOf(user);
      for (const blocked of ['Fuck you', 'f.u.c.k', 'F00kFuCk3r', 'B1tch', 'Admin', 'ADM1N', 'Moderator', 'Administrator2', 'shit']) {
        expect(await updateNickname(user, blocked)).toEqual({ ok: false, code: 'NICKNAME_NOT_ALLOWED' });
      }
      const [ordinary] = await sql`select array_agg(n) filter (where public.nickname_is_blocked(n)) as blocked
        from unnest(array['Kshitij', 'Shital', 'Dickens', 'Grape', 'Therapist', 'Randir', 'Lundgren', 'Adminton', 'Asha']) as n`;
      expect(ordinary!.blocked).toBeNull();
    });

    it('limits changes to 5 in 24 hours, and saving the same nickname is free', async () => {
      const user = await newUser();
      await profileOf(user);
      for (let i = 1; i <= 5; i += 1) {
        expect(await updateNickname(user, `Name ${i}`)).toMatchObject({ ok: true, changed: true });
        // A double-tap of the same save changes nothing and costs nothing.
        expect(await updateNickname(user, `Name ${i}`)).toMatchObject({ ok: true, changed: false });
      }
      const limited = await updateNickname(user, 'Name 6');
      expect(limited).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
      if (!limited.ok) {
        expect(limited.retry_after_seconds).toBeGreaterThan(23 * 3600);
        expect(limited.retry_after_seconds).toBeLessThanOrEqual(24 * 3600);
      }
      expect((await profileOf(user)).nickname).toBe('Name 5');

      // Once the oldest change is more than a day old, one more is allowed.
      await sql`update public.profiles set nickname_changes = array(select t - interval '25 hours' from unnest(nickname_changes) with ordinality as u(t, i) where i = 1)
        || nickname_changes[2:] where user_id = ${user}`;
      expect(await updateNickname(user, 'Name 6')).toMatchObject({ ok: true, changed: true });
      expect(await updateNickname(user, 'Name 7')).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    });

    it('concurrent saves leave one of the requested nicknames and a consistent count', async () => {
      const user = await newUser();
      await profileOf(user);
      const names = ['Alpha One', 'Beta Two', 'Gamma Three'];
      const results = await Promise.all(names.map((n) => updateNickname(user, n)));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(names).toContain((await profileOf(user)).nickname);
      const [row] = await sql`select cardinality(nickname_changes) as n from public.profiles where user_id = ${user}`;
      expect(row!.n).toBe(3);
    });
  });

  describe('Google link and deletion', () => {
    it('linking Google keeps the same player; the status comes from auth.identities only', async () => {
      const user = await newUser();
      const guest = await profileOf(user);
      await updateNickname(user, 'Asha');
      expect(guest.google_linked).toBe(false);

      // What Supabase Auth does when the guest links Google: same user id, a new identity.
      await sql`insert into auth.identities (user_id, provider) values (${user}, 'google')`;
      await sql`update auth.users set is_anonymous = false where id = ${user}`;
      const linked = await initProfile(user);
      expect(linked).toMatchObject({ ok: true, created: false, profile: { user_id: user, player_id: guest.player_id, nickname: 'Asha', google_linked: true } });

      // Another provider's identity is not a Google link; removing Google clears the status.
      const other = await newUser();
      await sql`insert into auth.identities (user_id, provider) values (${other}, 'email')`;
      expect((await profileOf(other)).google_linked).toBe(false);
      await sql`delete from auth.identities where user_id = ${user}`;
      expect((await profileOf(user)).google_linked).toBe(false);
    });

    it('deleting the Auth user removes the profile and nothing else', async () => {
      const leaving = await newUser();
      const staying = await newUser();
      await profileOf(leaving);
      const stayingProfile = await profileOf(staying);
      const [gamesBefore] = await sql`select count(*)::int as n from public.games`;

      await sql`delete from auth.users where id = ${leaving}`;

      const [gone] = await sql`select count(*)::int as n from public.profiles where user_id = ${leaving}`;
      expect(gone!.n).toBe(0);
      expect(await profileOf(staying)).toEqual(stayingProfile);
      const [gamesAfter] = await sql`select count(*)::int as n from public.games`;
      expect(gamesAfter!.n).toBe(gamesBefore!.n);
      // The deleted account's token, while it has not expired yet, opens nothing.
      expect(await initProfile(leaving)).toEqual({ ok: false, code: 'NO_USER' });
      expect(await as(leaving, (tx) => tx`select player_id from public.profiles`)).toHaveLength(0);
    });
  });
});
