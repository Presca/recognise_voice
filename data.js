"use strict";

/*
 * Curated singer dataset used for matching.
 * Ranges are approximate, commonly-cited *comfortable* singing ranges
 * (not extreme recorded ranges), which suits matching against a short
 * sung line. tone: "dark" | "warm" | "bright".
 */
const SINGERS = [
  {
    id: "freddie-mercury", name: "Freddie Mercury", type: "Tenor",
    low: "F2", high: "F5", tone: "bright", genres: ["Rock", "Pop"],
    blurb: "Queen's frontman — famous for a huge range, raw power and theatrical delivery.",
    songs: ["Somebody to Love", "Don't Stop Me Now", "Love of My Life"],
  },
  {
    id: "adele", name: "Adele", type: "Mezzo-soprano",
    low: "C3", high: "C5", tone: "warm", genres: ["Pop", "Soul"],
    blurb: "Rich, emotive mezzo with a warm lower register and powerful belts.",
    songs: ["Someone Like You", "Rolling in the Deep", "Easy on Me"],
  },
  {
    id: "ed-sheeran", name: "Ed Sheeran", type: "Tenor",
    low: "A2", high: "B4", tone: "warm", genres: ["Pop", "Folk"],
    blurb: "Soft, breathy tenor built for intimate, melodic pop and acoustic songs.",
    songs: ["Perfect", "Thinking Out Loud", "Photograph"],
  },
  {
    id: "beyonce", name: "Beyoncé", type: "Mezzo-soprano",
    low: "G3", high: "E5", tone: "bright", genres: ["R&B", "Pop"],
    blurb: "Agile, powerful mezzo with dazzling runs and precise control.",
    songs: ["Halo", "Love on Top", "If I Were a Boy"],
  },
  {
    id: "whitney-houston", name: "Whitney Houston", type: "Soprano",
    low: "C3", high: "C6", tone: "bright", genres: ["Pop", "R&B", "Gospel"],
    blurb: "One of the great pop voices — soaring belts and gospel-rooted phrasing.",
    songs: ["I Will Always Love You", "I Wanna Dance with Somebody", "Greatest Love of All"],
  },
  {
    id: "sam-smith", name: "Sam Smith", type: "Tenor",
    low: "C3", high: "B4", tone: "warm", genres: ["Pop", "Soul"],
    blurb: "Silky tenor with an effortless falsetto and emotional delivery.",
    songs: ["Stay with Me", "Too Good at Goodbyes", "Lay Me Down"],
  },
  {
    id: "ariana-grande", name: "Ariana Grande", type: "Soprano",
    low: "G3", high: "E6", tone: "bright", genres: ["Pop", "R&B"],
    blurb: "Light lyric soprano with a famous whistle register and nimble runs.",
    songs: ["Into You", "No Tears Left to Cry", "POV"],
  },
  {
    id: "bruno-mars", name: "Bruno Mars", type: "Tenor",
    low: "C3", high: "C5", tone: "bright", genres: ["Pop", "Funk", "R&B"],
    blurb: "Versatile retro-flavoured tenor — smooth, punchy and playful.",
    songs: ["When I Was Your Man", "Just the Way You Are", "Grenade"],
  },
  {
    id: "frank-sinatra", name: "Frank Sinatra", type: "Baritone",
    low: "G2", high: "G4", tone: "warm", genres: ["Jazz", "Swing"],
    blurb: "The definitive crooner — relaxed phrasing and a velvety baritone.",
    songs: ["Fly Me to the Moon", "My Way", "Come Fly with Me"],
  },
  {
    id: "johnny-cash", name: "Johnny Cash", type: "Bass-baritone",
    low: "E2", high: "E4", tone: "dark", genres: ["Country", "Folk"],
    blurb: "Deep, steady bass-baritone with a storyteller's gravitas.",
    songs: ["Ring of Fire", "I Walk the Line", "Hurt"],
  },
  {
    id: "barry-white", name: "Barry White", type: "Bass",
    low: "C2", high: "C4", tone: "dark", genres: ["Soul", "R&B", "Disco"],
    blurb: "Legendary low voice — smooth, resonant and unmistakably deep.",
    songs: ["Can't Get Enough of Your Love, Babe", "You're the First, the Last, My Everything", "Never, Never Gonna Give Ya Up"],
  },
  {
    id: "amy-winehouse", name: "Amy Winehouse", type: "Contralto",
    low: "D3", high: "D5", tone: "dark", genres: ["Soul", "Jazz", "R&B"],
    blurb: "Smoky contralto steeped in jazz — expressive, raw and instantly recognisable.",
    songs: ["Back to Black", "Valerie", "Tears Dry on Their Own"],
  },
  {
    id: "tracy-chapman", name: "Tracy Chapman", type: "Contralto",
    low: "F3", high: "C5", tone: "warm", genres: ["Folk", "Rock"],
    blurb: "Warm, grounded contralto with an honest folk storyteller's tone.",
    songs: ["Fast Car", "Give Me One Reason", "Baby Can I Hold You"],
  },
  {
    id: "norah-jones", name: "Norah Jones", type: "Contralto",
    low: "G3", high: "C5", tone: "warm", genres: ["Jazz", "Pop"],
    blurb: "Hushed, jazzy voice — mellow, intimate and effortlessly smooth.",
    songs: ["Don't Know Why", "Come Away with Me", "Sunrise"],
  },
  {
    id: "michael-buble", name: "Michael Bublé", type: "Baritone",
    low: "A2", high: "A4", tone: "warm", genres: ["Jazz", "Swing", "Pop"],
    blurb: "Modern crooner — polished baritone with a big-band swagger.",
    songs: ["Feeling Good", "Haven't Met You Yet", "Home"],
  },
  {
    id: "elvis-presley", name: "Elvis Presley", type: "Baritone",
    low: "G2", high: "B4", tone: "warm", genres: ["Rock", "Country", "Gospel"],
    blurb: "The King — a rich baritone with rock'n'roll energy and gospel soul.",
    songs: ["Can't Help Falling in Love", "Suspicious Minds", "Jailhouse Rock"],
  },
  {
    id: "david-bowie", name: "David Bowie", type: "Baritone",
    low: "G2", high: "G4", tone: "warm", genres: ["Rock", "Pop"],
    blurb: "Chameleonic baritone — dramatic, characterful and endlessly inventive.",
    songs: ["Heroes", "Life on Mars?", "Space Oddity"],
  },
  {
    id: "hozier", name: "Hozier", type: "Baritone",
    low: "A2", high: "A4", tone: "dark", genres: ["Rock", "Soul", "Folk"],
    blurb: "Bluesy baritone with gospel weight and a haunting falsetto.",
    songs: ["Take Me to Church", "Cherry Wine", "Work Song"],
  },
  {
    id: "lewis-capaldi", name: "Lewis Capaldi", type: "Tenor",
    low: "C3", high: "B4", tone: "warm", genres: ["Pop", "Soul"],
    blurb: "Gravelly, emotional tenor made for heart-on-sleeve ballads.",
    songs: ["Someone You Loved", "Before You Go", "Bruises"],
  },
  {
    id: "billie-eilish", name: "Billie Eilish", type: "Mezzo-soprano",
    low: "G3", high: "B4", tone: "dark", genres: ["Pop", "Alternative"],
    blurb: "Soft-spoken, breathy mezzo — understated, moody and intimate.",
    songs: ["Ocean Eyes", "Lovely", "What Was I Made For?"],
  },
  {
    id: "lana-del-rey", name: "Lana Del Rey", type: "Mezzo-soprano",
    low: "F3", high: "C5", tone: "dark", genres: ["Pop", "Alternative"],
    blurb: "Cinematic, melancholic mezzo with a vintage haze.",
    songs: ["Video Games", "Summertime Sadness", "Young and Beautiful"],
  },
  {
    id: "taylor-swift", name: "Taylor Swift", type: "Mezzo-soprano",
    low: "G3", high: "D5", tone: "warm", genres: ["Pop", "Country", "Folk"],
    blurb: "Conversational, melodic voice built around storytelling.",
    songs: ["Love Story", "Blank Space", "Anti-Hero"],
  },
  {
    id: "sia", name: "Sia", type: "Mezzo-soprano",
    low: "A3", high: "E5", tone: "bright", genres: ["Pop"],
    blurb: "Explosive, raspy belter with huge, cathartic choruses.",
    songs: ["Chandelier", "Elastic Heart", "Cheap Thrills"],
  },
  {
    id: "celine-dion", name: "Céline Dion", type: "Soprano",
    low: "B2", high: "C6", tone: "bright", genres: ["Pop"],
    blurb: "Powerhouse balladeer — enormous range, precision and drama.",
    songs: ["My Heart Will Go On", "The Power of Love", "It's All Coming Back to Me Now"],
  },
  {
    id: "mariah-carey", name: "Mariah Carey", type: "Soprano",
    low: "F3", high: "G6", tone: "bright", genres: ["Pop", "R&B"],
    blurb: "Five-octave icon — melismatic runs and a signature whistle register.",
    songs: ["Hero", "We Belong Together", "Always Be My Baby"],
  },
  {
    id: "john-legend", name: "John Legend", type: "Tenor",
    low: "C3", high: "A4", tone: "warm", genres: ["R&B", "Soul", "Pop"],
    blurb: "Smooth soul tenor — piano-led, romantic and refined.",
    songs: ["All of Me", "Ordinary People", "Tonight (Best You Ever Had)"],
  },
  {
    id: "stevie-wonder", name: "Stevie Wonder", type: "Tenor",
    low: "C3", high: "C5", tone: "bright", genres: ["Soul", "Funk", "R&B"],
    blurb: "Joyful, elastic tenor with impeccable groove and melodic invention.",
    songs: ["Isn't She Lovely", "Superstition", "Signed, Sealed, Delivered"],
  },
  {
    id: "leonard-cohen", name: "Leonard Cohen", type: "Bass-baritone",
    low: "D2", high: "C4", tone: "dark", genres: ["Folk", "Rock"],
    blurb: "Gravelly, poetic low voice — half sung, half spoken, all gravitas.",
    songs: ["Hallelujah", "Suzanne", "Dance Me to the End of Love"],
  },
  {
    id: "toni-braxton", name: "Toni Braxton", type: "Contralto",
    low: "C3", high: "C5", tone: "dark", genres: ["R&B", "Pop"],
    blurb: "Sultry, velvety contralto — one of R&B's richest low voices.",
    songs: ["Un-Break My Heart", "Breathe Again", "He Wasn't Man Enough"],
  },
  {
    id: "shawn-mendes", name: "Shawn Mendes", type: "Tenor",
    low: "B2", high: "B4", tone: "warm", genres: ["Pop"],
    blurb: "Bright pop tenor with an easy falsetto and guitar-driven hooks.",
    songs: ["Stitches", "Mercy", "There's Nothing Holdin' Me Back"],
  },
  {
    id: "dua-lipa", name: "Dua Lipa", type: "Mezzo-soprano",
    low: "F3", high: "B4", tone: "dark", genres: ["Pop", "Dance"],
    blurb: "Cool, low-slung mezzo made for disco-pop grooves.",
    songs: ["Levitating", "Don't Start Now", "New Rules"],
  },
  {
    id: "rihanna", name: "Rihanna", type: "Alto",
    low: "G3", high: "C5", tone: "warm", genres: ["Pop", "R&B", "Dance"],
    blurb: "Distinctive, edgy alto with instantly memorable hooks.",
    songs: ["Diamonds", "Stay", "Umbrella"],
  },
  {
    id: "chris-stapleton", name: "Chris Stapleton", type: "Tenor",
    low: "A2", high: "B4", tone: "dark", genres: ["Country", "Rock", "Blues"],
    blurb: "Whiskey-soaked country tenor with serious blues power.",
    songs: ["Tennessee Whiskey", "Broken Halos", "Starting Over"],
  },
  {
    id: "dolly-parton", name: "Dolly Parton", type: "Soprano",
    low: "G3", high: "D5", tone: "bright", genres: ["Country", "Pop"],
    blurb: "Sparkling country soprano with a quicksilver vibrato.",
    songs: ["Jolene", "9 to 5", "I Will Always Love You"],
  },
  {
    id: "aretha-franklin", name: "Aretha Franklin", type: "Mezzo-soprano",
    low: "F3", high: "E5", tone: "bright", genres: ["Soul", "Gospel", "R&B"],
    blurb: "The Queen of Soul — gospel fire, effortless power and total command.",
    songs: ["Respect", "(You Make Me Feel Like) A Natural Woman", "Think"],
  },
];

function spotifyUrl(title, artist) {
  return "https://open.spotify.com/search/" + encodeURIComponent(title + " " + artist);
}

function youtubeUrl(title, artist) {
  return "https://www.youtube.com/results?search_query=" + encodeURIComponent(artist + " " + title);
}

function karaokeUrl(title, artist) {
  return "https://www.youtube.com/results?search_query=" + encodeURIComponent(artist + " " + title + " karaoke");
}
