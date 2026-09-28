/**
 * Where the world data comes from. All free, none needing an account.
 *
 * Kept in one file so the wearechintu copy can point the two that are served
 * by the app itself at its own paths (see scripts/sync-wearechintu.mjs).
 */

/**
 * Fine-particle air pollution (PM2.5), population-weighted yearly average per
 * country, in micrograms per cubic metre. WHO data, published by Our World in
 * Data, which allows it to be fetched from a browser.
 */
export const AIR_POLLUTION_CSV =
  'https://ourworldindata.org/grapher/outdoor-air-pollution-exposure.csv?v=1&csvType=full&useColumnShortNames=true'

/**
 * Plastic each country sends into the ocean per year, in tonnes. Meijer et al.
 * (2021), via Our World in Data.
 */
export const OCEAN_PLASTIC_CSV =
  'https://ourworldindata.org/grapher/plastic-waste-emitted-to-the-ocean.csv?v=1&csvType=full&useColumnShortNames=true'

/**
 * Quality of life: the Human Development Index, the UN's single figure for
 * health, schooling and income together, from 0 to 1. UNDP, via Our World in
 * Data.
 */
export const QUALITY_OF_LIFE_CSV =
  'https://ourworldindata.org/grapher/human-development-index.csv?v=1&csvType=full&useColumnShortNames=true'

/**
 * Water quality: the share of a country's rivers, lakes and groundwater found
 * to be in good condition when tested (UN goal 6.3.2), in per cent. UN
 * Environment Programme, via Our World in Data.
 */
export const WATER_QUALITY_CSV =
  'https://ourworldindata.org/grapher/water-bodies-good-water-quality.csv?v=1&csvType=full&useColumnShortNames=true'

/**
 * Wealth: GDP per person, adjusted for what money buys in each country, in
 * international dollars. World Bank, via Our World in Data. Not a map layer:
 * the findings use it to hold wealth level when comparing the others.
 */
export const GDP_PER_PERSON_CSV =
  'https://ourworldindata.org/grapher/gdp-per-capita-worldbank.csv?v=1&csvType=full&useColumnShortNames=true'

/**
 * Plastic waste per person that is not properly handled -- dumped, burned in
 * the open or leaked -- in kilograms a year. For the findings: comparing
 * countries by their total plastic would mostly compare their sizes.
 * Meijer and others, via Our World in Data.
 */
export const PLASTIC_PER_PERSON_CSV =
  'https://ourworldindata.org/grapher/mismanaged-plastic-waste-per-capita.csv?v=1&csvType=full&useColumnShortNames=true'

/**
 * Each country figure's file and the column its figure is in. Named, because
 * several of these files carry more than one figure, and a file that changes
 * shape should fail to read, not quietly give the wrong figure.
 */
export const COUNTRY_COLUMNS = {
  air: 'population_weighted_pm25',
  plastic: 'mismanaged_waste_emitted_to_the_ocean__metric_tons_year_1',
  life: 'hdi__sex_total',
  // Every kind of water body together: rivers, lakes and groundwater.
  water: '_6_3_2__en_h2o_wbambq',
  gdp: 'ny_gdp_pcap_pp_kd',
  plasticPerPerson: 'mismanaged_plastic_waste_per_capita__kg_per_year',
} as const

/**
 * Fires seen by NASA's MODIS satellites in the last 24 hours. NASA publishes
 * the file openly but does not allow a browser to fetch it from another site,
 * so it is passed through the app's own server: the Vite dev server here, a
 * route in wearechintu.
 */
export const FIRES_ENDPOINT = '/api/world/fires'
export const FIRES_UPSTREAM =
  'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv'

/**
 * Copies of every source, saved with the app and used only when the live file
 * cannot be reached: offline, or with a source down. Slimmed to what the app
 * uses. Refreshed with scripts/save-world-data.mjs.
 */
export const SAVED_COPIES = {
  air: '/data/air-saved.csv',
  plastic: '/data/plastic-saved.csv',
  fires: '/data/fires-saved.csv',
  life: '/data/life-saved.csv',
  water: '/data/water-saved.csv',
  gdp: '/data/gdp-saved.csv',
  plasticPerPerson: '/data/plastic-per-person-saved.csv',
} as const

/** The day those copies were saved. Written by scripts/save-world-data.mjs. */
export const SAVED_ON = '2026-09-28'

/** Country outlines, Natural Earth at 1:110m (public domain), slimmed to a name and a code. */
export const COUNTRIES_URL = '/data/countries.geojson'
