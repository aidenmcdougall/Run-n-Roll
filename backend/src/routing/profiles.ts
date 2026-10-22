import { RUN_PROFILE, RUN_SKATE_PROFILE, SKATE_PROFILE } from './activities.js';
import { PREFER_PATHS_PROFILE, SHORTEST_PROFILE, validateProfile, type RoutingProfile } from './weights.js';

/** Every routing profile a request may name, by id. */
export const ROUTING_PROFILES: Readonly<Record<string, RoutingProfile>> = Object.fromEntries(
  [PREFER_PATHS_PROFILE, RUN_PROFILE, SKATE_PROFILE, RUN_SKATE_PROFILE, SHORTEST_PROFILE].map((p) => [p.id, p]),
);

export const DEFAULT_PROFILE_ID = PREFER_PATHS_PROFILE.id;

for (const profile of Object.values(ROUTING_PROFILES)) validateProfile(profile);
