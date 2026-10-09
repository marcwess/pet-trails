import { CONFIG, createStarterProfile, mulberry32, type Profile } from '@pet-trails/shared';

const KEY = 'pet-trails-profile-v1';

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Profile;
      if (parsed && parsed.v === 1 && parsed.pet && typeof parsed.pet.species === 'number') return parsed;
    }
  } catch {
    /* fresh profile */
  }
  const profile = createStarterProfile(mulberry32((Date.now() ^ 0x9e3779b9) >>> 0));
  profile.pet.level = Math.min(CONFIG.levelCap, profile.pet.level);
  saveProfile(profile);
  return profile;
}

export function saveProfile(profile: Profile): void {
  localStorage.setItem(KEY, JSON.stringify(profile));
}
