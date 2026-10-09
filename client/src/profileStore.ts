import { CONFIG, createStarterProfile, equippedPet, mulberry32, normalizeProfile, randomSeed, type Profile } from '@pet-trails/shared';

const KEY = 'pet-trails-profile-v1';

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = normalizeProfile(JSON.parse(raw));
      if (parsed) {
        const pet = equippedPet(parsed);
        pet.level = Math.min(CONFIG.levelCap, Math.max(1, pet.level));
        return parsed;
      }
    }
  } catch {
    /* fresh profile */
  }
  const profile = createStarterProfile(mulberry32(randomSeed()));
  saveProfile(profile);
  return profile;
}

export function saveProfile(profile: Profile): void {
  localStorage.setItem(KEY, JSON.stringify(profile));
}
