// Names at a matchmade table. A nickname is free text and need not be unique; the game engine
// wants 1–20 characters of letters, digits, spaces and . ' _ - and one name per player at a table
// (PlayerNameSchema, NAME_TAKEN). This turns the nicknames of the assigned players into names the
// engine accepts, without ever refusing a player: characters the engine does not take are dropped,
// an empty result becomes "Player", and a name already at the table gets a number.

const MAX_LENGTH = 20;
const FALLBACK = 'Player';

/** One nickname as the engine will take it (not yet unique). */
export function seatNameOf(nickname: string): string {
  const cleaned = String(nickname ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} .'_-]+/gu, ' ')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, MAX_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : FALLBACK;
}

/** Engine-valid names for the players of one table, in the order given: no two alike (ignoring case). */
export function seatNames(nicknames: readonly string[]): string[] {
  const taken = new Set<string>();
  return nicknames.map((nickname) => {
    const base = seatNameOf(nickname);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
      const suffix = ` ${n}`;
      name = `${base.slice(0, MAX_LENGTH - suffix.length).trim()}${suffix}`;
    }
    taken.add(name.toLowerCase());
    return name;
  });
}
