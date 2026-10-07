import { describe, expect, it } from 'vitest';
import {
  getDeed,
  groupMembers,
  PROPERTY_DEEDS,
  PROPERTY_KEYS,
  type CityDeed,
  type PropertyKey,
  type TransportDeed,
} from '@/engine/index.ts';

/** Exact values from the photographed title deeds (spec §9). */
const CITY_DEEDS: Record<string, [string, number, number[], number, number, number, number]> = {
  // key: [group, price, [site, 1h, 2h, 3h], hotel, houseCost, hotelCost, mortgage]
  MUMBAI: ['BLUE', 8500, [1200, 4000, 5500, 7500], 9000, 7500, 7500, 4250],
  AHMEDABAD: ['BLUE', 4000, [400, 1500, 3000, 4200], 5000, 4500, 4500, 2000],
  CALCUTTA: ['BLUE', 6500, [800, 3200, 4500, 6500], 8000, 6000, 6000, 3250],
  HYDERABAD: ['BLUE', 3500, [300, 1200, 3000, 4500], 6000, 5000, 5000, 1750],
  DARJEELING: ['BLUE', 2500, [200, 1200, 2600, 3500], 5000, 3000, 3000, 1250],
  SHIMLA: ['PURPLE', 2200, [200, 1000, 2750, 4500], 6000, 3500, 3500, 1100],
  MADRAS: ['PURPLE', 7000, [900, 3500, 5000, 7000], 8500, 6500, 6500, 3500],
  AMRITSAR: ['PURPLE', 3300, [300, 1400, 2800, 4000], 5000, 4500, 4500, 1050],
  SRINAGAR: ['PURPLE', 5000, [550, 3500, 5000, 7000], 8000, 6000, 6000, 2500],
  BANGALORE: ['PURPLE', 4000, [400, 1500, 3000, 4500], 5500, 4500, 4500, 2000],
  INDORE: ['GREEN', 1500, [200, 600, 1500, 2500], 3600, 2000, 2000, 750],
  AGRA: ['GREEN', 2500, [200, 900, 1600, 2500], 3500, 3000, 3000, 1250],
  KANPUR: ['GREEN', 4000, [400, 1500, 3000, 4500], 5500, 4500, 4500, 2000],
  PATNA: ['GREEN', 2000, [150, 800, 2000, 3000], 4500, 2500, 2500, 1000],
  JAIPUR: ['GREEN', 3000, [250, 1500, 2700, 4000], 5500, 4000, 4000, 1500],
  DELHI: ['PINK', 6000, [750, 3000, 4300, 5500], 7500, 5000, 5000, 4000],
  CHANDIGARH: ['PINK', 2500, [200, 900, 1600, 2500], 3500, 3000, 3000, 1250],
  COCHIN: ['PINK', 3000, [300, 1200, 2000, 4250], 5500, 4000, 4000, 1500],
  OOTACAMUND: ['PINK', 2500, [200, 1000, 2250, 3500], 4500, 3000, 3000, 1250],
  MARGAO: ['PINK', 4000, [400, 2200, 3500, 5000], 6500, 4500, 4500, 2000],
};

/** Board property list purchase prices (spec §8). */
const BOARD_LIST_PRICES: Partial<Record<PropertyKey, number>> = {
  MUMBAI: 8500,
  AHMEDABAD: 4000,
  DARJEELING: 2500,
  CALCUTTA: 6500,
  HYDERABAD: 3500,
  MADRAS: 7000,
  BANGALORE: 4000,
  MARGAO: 4000,
  MOTOR_BOAT: 5500,
  BEST: 3500,
  ELECTRIC_COMPANY: 2500,
  CHANDIGARH: 2500,
  DELHI: 6000,
  SHIMLA: 2200,
  SRINAGAR: 5000,
  AMRITSAR: 3300,
  WATER_WORKS: 3200,
  RAILWAY: 9500,
  INDORE: 1500,
  AGRA: 2500,
  KANPUR: 4000,
  PATNA: 2000,
  JAIPUR: 3000,
  COCHIN: 3000,
  OOTACAMUND: 2500,
};

describe('Business V1 title deeds — exact photographed values', () => {
  it.each(Object.entries(CITY_DEEDS))('%s', (key, [group, price, rent, hotel, houseCost, hotelCost, mortgage]) => {
    const deed = getDeed(key as PropertyKey) as CityDeed;
    expect(deed.kind).toBe('CITY');
    expect(deed.group).toBe(group);
    expect(deed.price).toBe(price);
    expect([...deed.rent]).toEqual(rent);
    expect(deed.hotelRent).toBe(hotel);
    expect(deed.houseCost).toBe(houseCost);
    expect(deed.hotelCost).toBe(hotelCost);
    expect(deed.mortgageValue).toBe(mortgage);
  });

  it('MUMBAI spot check (spec §32)', () => {
    const d = getDeed('MUMBAI') as CityDeed;
    expect([d.price, ...d.rent, d.hotelRent]).toEqual([8500, 1200, 4000, 5500, 7500, 9000]);
  });

  it('AHMEDABAD spot check (spec §32)', () => {
    const d = getDeed('AHMEDABAD') as CityDeed;
    expect([d.price, ...d.rent, d.hotelRent]).toEqual([4000, 400, 1500, 3000, 4200, 5000]);
  });

  it.each(Object.entries(BOARD_LIST_PRICES))('board list price %s = %i', (key, price) => {
    expect(getDeed(key as PropertyKey).price).toBe(price);
  });

  it('transport/utility deeds', () => {
    const t = (k: PropertyKey) => getDeed(k) as TransportDeed;
    expect(t('RAILWAY')).toMatchObject({ price: 9500, mortgageValue: 4750, rent: { type: 'FIXED', base: 1000, pairedWith: 'BEST', pairedRent: 1350 } });
    expect(t('AIR_INDIA')).toMatchObject({ price: 10500, mortgageValue: 4750, rent: { type: 'FIXED', base: 1200, pairedWith: 'WATER_WORKS', pairedRent: 1350 } });
    expect(t('MOTOR_BOAT')).toMatchObject({
      price: 5500,
      mortgageValue: 1750,
      rent: { type: 'DICE_MULTIPLIER', multiplier: 100, pairedWith: 'ELECTRIC_COMPANY', pairedMultiplier: 200 },
    });
    expect(t('BEST')).toMatchObject({ price: 3500, mortgageValue: 1750, rent: { type: 'FIXED', base: 600, pairedWith: 'RAILWAY', pairedRent: 1350 } });
    expect(t('ELECTRIC_COMPANY')).toMatchObject({
      price: 2500,
      mortgageValue: 1750,
      rent: { type: 'DICE_MULTIPLIER', multiplier: 50, pairedWith: 'MOTOR_BOAT', pairedMultiplier: 100 },
    });
    expect(t('WATER_WORKS')).toMatchObject({ price: 3200, mortgageValue: 1600, rent: { type: 'FIXED', base: 500, pairedWith: 'AIR_INDIA', pairedRent: 1000 } });
  });

  it('has 26 purchasable properties in four colour groups of five plus six transport/utility', () => {
    expect(PROPERTY_KEYS).toHaveLength(26);
    for (const g of ['BLUE', 'PURPLE', 'GREEN', 'PINK'] as const) expect(groupMembers(g)).toHaveLength(5);
    expect(groupMembers('TRANSPORT_UTILITY')).toHaveLength(6);
    for (const k of PROPERTY_KEYS) expect(PROPERTY_DEEDS[k].key).toBe(k);
  });
});
