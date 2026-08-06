import type { GameState, PlayerState } from "../model/game-state.js";
import type { GearInstance } from "../model/card.js";
import { defaultCardRegistry } from "../cards/card-registry.js";

/**
 * Equipment attachment — SFD's headline subsystem, and the one the survey called
 * the set's largest single piece of work at 53 cards.
 *
 * # What an Equipment IS here
 *
 * A Gear carrying the printed `Equipment` tag. Attaching does NOT move it: it
 * stays in its controller's `activeGear` exactly as before, and
 * `attachedToInstanceId` is state layered on top. That field already existed on
 * `GearInstance` before any of this, for Fading Memories.
 *
 * # Three rules that shaped this, each read off a card rather than assumed
 *
 * **Re-equipping MOVES it; it does not require detaching first.**
 * `[Weaponmaster]`'s own reminder text is explicit — "you may [Equip] one of
 * your Equipment to me for 1 rainbow less, **even if it's already attached**".
 * So `attachEquipment` makes no attached-vs-unattached distinction.
 *
 * **A unit leaving play DETACHES its Equipment; it does not destroy it.** The
 * Zero Drive's "Use only if unattached" and Spinning Axe's "if this is
 * unattached, kill it" both presuppose a Gear outliving its wearer, sitting
 * unattached.
 *
 * **The `[Equip]` cost is completely independent of the Gear's PLAY cost.**
 * Doran's Blade is played for 2 Energy and equipped for 1 Body Power. A Gear is
 * played to `activeGear` exactly as before and `[Equip]` is a second,
 * separately-paid ability that attaches it later.
 *
 * # One choke point
 *
 * `attachEquipment` and `detachEquipment` are the only writers of
 * `attachedToInstanceId`. Nothing else assigns it, so a future attach source
 * cannot skip whatever these grow to do — the same convention that makes
 * `readyUnit` the only thing that fires `unitReadied`.
 */

/** Is this Gear an Equipment — i.e. does its printed card carry the tag? Asked
 *  of the DEFINITION rather than the instance, because the tag is printed and
 *  cannot change in play. */
export function isEquipmentGear(gear: { defId: string }): boolean {
  const def = defaultCardRegistry().tryGet(gear.defId);
  return def?.type === "Gear" && def.isEquipment === true;
}

/** The "+N Might" badge this Equipment grants, or 0. Art-only data — see
 *  `card-loader`'s EQUIP_MIGHT_BONUS for why it is a table. */
export function equipMightBonusOf(gear: { defId: string }): number {
  const def = defaultCardRegistry().tryGet(gear.defId);
  return def?.type === "Gear" ? (def.equipMightBonus ?? 0) : 0;
}

/**
 * Attaches `gearInstanceId` to `unitInstanceId`, moving it if it was already
 * attached elsewhere.
 *
 * A no-op when the gear is not the player's — attaching is always "an Equipment
 * YOU control to a unit YOU control", and a silent no-op is the same
 * target-vanished convention every other helper here follows.
 */
export function attachEquipment(
  state: GameState,
  ownerIndex: 0 | 1,
  gearInstanceId: string,
  unitInstanceId: string,
): GameState {
  const owner = state.players[ownerIndex];
  if (!owner.activeGear.some((g) => g.instanceId === gearInstanceId)) return state;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = {
    ...owner,
    activeGear: owner.activeGear.map((g) =>
      g.instanceId === gearInstanceId ? { ...g, attachedToInstanceId: unitInstanceId } : g,
    ),
  };
  return { ...state, players };
}

/** Detaches one Equipment, leaving it in `activeGear` unattached. */
export function detachEquipment(state: GameState, ownerIndex: 0 | 1, gearInstanceId: string): GameState {
  const owner = state.players[ownerIndex];
  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = {
    ...owner,
    activeGear: owner.activeGear.map((g) =>
      g.instanceId === gearInstanceId ? { ...g, attachedToInstanceId: null } : g,
    ),
  };
  return { ...state, players };
}

/**
 * Detaches every Equipment attached to `unitInstanceId`, from BOTH players.
 *
 * Both, deliberately: nothing in the rules says an Equipment and the unit it is
 * attached to share a controller, and `takeControlOfUnit` already moves units
 * between lists. Scanning one side would leave a dangling
 * `attachedToInstanceId` pointing at a unit that no longer exists — which reads
 * as a Might bonus from a gear attached to nothing.
 *
 * Called from every path a unit leaves play by. The gear SURVIVES: see the
 * module comment's two cards that presuppose exactly that.
 */
export function detachAllFrom(state: GameState, unitInstanceId: string): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  let changed = false;
  for (const index of [0, 1] as const) {
    const player = players[index];
    if (!player.activeGear.some((g) => g.attachedToInstanceId === unitInstanceId)) continue;
    changed = true;
    players[index] = {
      ...player,
      activeGear: player.activeGear.map((g) =>
        g.attachedToInstanceId === unitInstanceId ? { ...g, attachedToInstanceId: null } : g,
      ),
    };
  }
  return changed ? { ...state, players } : state;
}

/** Every Equipment attached to this unit, from either side. */
export function equipmentAttachedTo(state: GameState, unitInstanceId: string): GearInstance[] {
  return state.players.flatMap((p) => p.activeGear.filter((g) => g.attachedToInstanceId === unitInstanceId));
}

/** The total "+N Might" an attached Equipment grants this unit. Read at the
 *  gate by `effective-might`, so it is continuous rather than a stored buff —
 *  detaching the gear removes the Might in the same instant. */
export function equipmentMightBonusFor(state: GameState, unitInstanceId: string): number {
  return equipmentAttachedTo(state, unitInstanceId).reduce((sum, g) => sum + equipMightBonusOf(g), 0);
}
