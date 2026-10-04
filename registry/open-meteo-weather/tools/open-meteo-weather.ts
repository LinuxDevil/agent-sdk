import { z } from 'zod';
import { defineTool } from '@lousho/build-ai-agent';

interface GeocodingResponse {
  results?: { latitude: number; longitude: number; name: string; country?: string }[];
}

interface ForecastResponse {
  current_weather?: { temperature: number; windspeed: number; winddirection: number; weathercode: number; time: string };
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`request failed: HTTP ${response.status}`);
  return response.json();
}

export default defineTool({
  name: 'open-meteo-weather',
  description: 'Get the current weather for a city through the Open-Meteo API (free, no API key)',
  input: z.object({ city: z.string().describe('The city to look up, e.g. "Berlin"') }),
  async execute({ city }) {
    const geo = (await readJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`)) as GeocodingResponse;
    const place = geo.results?.[0];
    if (!place) return { error: `No place named '${city}' found.` };
    const forecast = (await readJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current_weather=true`
    )) as ForecastResponse;
    return { place: `${place.name}${place.country ? `, ${place.country}` : ''}`, weather: forecast.current_weather ?? null };
  },
});
