/**
 * Gujarati / English strings.
 *
 * Deliberately a plain typed dictionary rather than an i18n framework: the surface is small, the
 * bundle must stay light, and a missing key becomes a TypeScript error rather than a mystery
 * "registry.title" appearing on a projector in front of SCRB.
 *
 * The Gujarati is the operator-facing half. Control-room staff and constables are the actual users
 * of this system, and an English-only police UI is not a serious submission.
 */

export const LOCALES = ['en', 'gu'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABEL: Record<Locale, string> = {
  en: 'English',
  gu: 'ગુજરાતી',
};

type Dict = Record<string, { en: string; gu: string }>;

export const STRINGS = {
  'app.name': { en: 'DrishtiNet', gu: 'દૃષ્ટિનેટ' },
  'app.tagline': {
    en: 'Statewide CCTV registry and vehicle analytics',
    gu: 'રાજ્યવ્યાપી સીસીટીવી રજિસ્ટ્રી અને વાહન વિશ્લેષણ',
  },

  'nav.registry': { en: 'Registry', gu: 'રજિસ્ટ્રી' },
  'nav.wall': { en: 'Video wall', gu: 'વિડિયો વોલ' },
  'nav.alerts': { en: 'Alerts', gu: 'ચેતવણીઓ' },
  'nav.search': { en: 'Forensic search', gu: 'ફોરેન્સિક શોધ' },
  'nav.audit': { en: 'Audit', gu: 'ઓડિટ' },

  'registry.title': { en: 'Camera registry', gu: 'કેમેરા રજિસ્ટ્રી' },
  'registry.cameras': { en: 'Cameras', gu: 'કેમેરા' },
  'registry.districts': { en: 'Districts', gu: 'જિલ્લાઓ' },
  'registry.online': { en: 'Online', gu: 'ઓનલાઇન' },
  'registry.degraded': { en: 'Degraded', gu: 'મર્યાદિત' },
  'registry.offline': { en: 'Offline', gu: 'ઓફલાઇન' },

  'status.unverified': { en: 'Status unverified', gu: 'સ્થિતિ ચકાસાયેલ નથી' },
  'status.measured': { en: 'Measured', gu: 'માપેલ' },
  'status.portalClaim': { en: 'Reported by portal', gu: 'પોર્ટલ દ્વારા જાહેર' },

  'location.verified': { en: 'Verified location', gu: 'ચકાસાયેલ સ્થાન' },
  'location.approximate': { en: 'Approximate location', gu: 'અંદાજિત સ્થાન' },
  'location.unverified': { en: 'Location unverified', gu: 'સ્થાન ચકાસાયેલ નથી' },

  'dept.unassigned': { en: 'Unassigned', gu: 'સોંપાયેલ નથી' },
  'dept.title': { en: 'Department', gu: 'વિભાગ' },

  'gap.title': { en: 'What this registry does not know', gu: 'આ રજિસ્ટ્રી શું જાણતી નથી' },
  'gap.locationUnverified': { en: 'Positions unverified', gu: 'સ્થાન ચકાસાયેલ નથી' },
  'gap.statusUnverified': { en: 'Availability unverified', gu: 'ઉપલબ્ધતા ચકાસાયેલ નથી' },
  'gap.deptUnassigned': { en: 'Departments unassigned', gu: 'વિભાગ સોંપાયેલ નથી' },

  'map.legend': { en: 'Legend', gu: 'સંકેત' },
  'map.uncertainty': { en: 'Position uncertainty', gu: 'સ્થાન અનિશ્ચિતતા' },
  'map.noPosition': { en: 'No position — shown at district centroid', gu: 'સ્થાન નથી — જિલ્લા કેન્દ્રમાં દર્શાવેલ' },

  'time.shifted': { en: 'TIME-SHIFT (demo)', gu: 'સમય-પરિવર્તન (ડેમો)' },
  'time.recorded': { en: 'Recorded', gu: 'રેકોર્ડ થયેલ' },
  'time.slot': { en: 'Playback slot', gu: 'પ્લેબેક સ્લોટ' },

  'common.search': { en: 'Search', gu: 'શોધો' },
  'common.of': { en: 'of', gu: 'માંથી' },
  'common.showing': { en: 'Showing', gu: 'દર્શાવેલ' },
  'common.all': { en: 'All', gu: 'બધા' },
  'common.close': { en: 'Close', gu: 'બંધ કરો' },
  'common.loading': { en: 'Loading', gu: 'લોડ થઈ રહ્યું છે' },
} as const satisfies Dict;

export type StringKey = keyof typeof STRINGS;

export function t(key: StringKey, locale: Locale): string {
  return STRINGS[key][locale];
}

/** Bind a locale once, so components read `tr('registry.title')`. */
export function translator(locale: Locale): (key: StringKey) => string {
  return (key) => t(key, locale);
}

export function isLocale(value: string | undefined): value is Locale {
  return value === 'en' || value === 'gu';
}
