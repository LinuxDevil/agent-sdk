import { describe, expect, it } from 'vitest';
import { rankToolsByKeywords, searchWords } from './toolSearchRank';

const tools = [
  { name: 'convert_currency', description: 'Convert an amount of money from one currency to another' },
  { name: 'exchange_rates', description: 'List currency exchange rates' },
  { name: 'get_weather', description: 'Get the weather forecast for a city' },
  { name: 'github__create_issue', description: 'Open an issue in a repository' },
  { name: 'lookupStock', description: 'Look up a stock price' },
];

describe('rankToolsByKeywords (N2)', () => {
  it('scores name hits above description hits, case-insensitively', () => {
    expect(rankToolsByKeywords('Currency', tools)).toEqual(['convert_currency', 'exchange_rates']);
    expect(rankToolsByKeywords('EXCHANGE', tools)).toEqual(['exchange_rates']);
  });

  it('splits names on _, -, __ and camelCase', () => {
    expect(rankToolsByKeywords('github issue', tools)).toEqual(['github__create_issue']);
    expect(rankToolsByKeywords('stock', tools)).toEqual(['lookupStock']);
    expect(searchWords('x-b__c_dE')).toEqual(['x', 'b', 'c', 'd', 'e']);
    expect(searchWords('What are the currencies for tools?')).toEqual(['currency', 'tool']);
  });

  it('adds up several words, and matches singular and plural', () => {
    expect(rankToolsByKeywords('rates for currencies', tools)).toEqual(['exchange_rates', 'convert_currency']);
    expect(rankToolsByKeywords('weather forecasts', tools)[0]).toBe('get_weather');
  });

  it('orders ties by name and leaves out tools with no shared word', () => {
    const tied = [
      { name: 'b_tool', description: 'search' },
      { name: 'a_tool', description: 'search' },
      { name: 'c_other', description: 'nothing' },
    ];
    expect(rankToolsByKeywords('search', tied)).toEqual(['a_tool', 'b_tool']);
    expect(rankToolsByKeywords('', tied)).toEqual([]);
    expect(rankToolsByKeywords('?!', tied)).toEqual([]);
  });
});
