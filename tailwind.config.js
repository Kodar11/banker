/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        felt: { DEFAULT: '#0F5132', dark: '#0A3A24', light: '#1B7A4D' },
        cream: '#FFF8E7',
        ink: '#1F1B16',
        saffron: { DEFAULT: '#F59E0B', dark: '#B45309' },
        brick: '#C2410C',
        // Mirrors PROPERTY_* tokens in src/constants/theme.ts (property groups only).
        deed: {
          blue: '#315D8C',
          purple: '#76579A',
          green: '#4F8A5B',
          pink: '#C86D8B',
          transport: '#F4F0E6',
        },
      },
      fontSize: {
        hero: ['44px', { lineHeight: '50px', fontWeight: '800' }],
      },
    },
  },
  plugins: [],
};
