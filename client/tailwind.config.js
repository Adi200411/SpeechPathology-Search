/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0B1021",
        foam: "#F6F7FB",
        accent: "#FF6B6B",
        accentSoft: "#FFE4E6",
        lime: "#C6F68D",
        sky: "#7DD3FC",
        grape: "#9F7AEA",
      },
    },
  },
  plugins: [],
}
