/* Majin — Tailwind build config. Classes are collected from the HTML and from the
   template strings in app.js, then compiled into a static stylesheet
   (public/css/tailwind.css) so the app ships no runtime CSS compiler and works
   with no internet. Rebuild after editing markup: `npm run css`. */
module.exports = {
  darkMode: 'class',
  content: ['./public/index.html', './public/js/**/*.js'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'sans-serif'] },
      colors: {
        brand: {
          500: '#3b82f6', 600: '#2563eb',
          cyan: '#06b6d4', purple: '#8b5cf6',
          darkBg: '#0b0f19', panelBg: '#111827', border: '#1e293b'
        }
      }
    }
  },
  plugins: []
};
