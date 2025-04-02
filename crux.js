import dotenv from 'dotenv';

dotenv.config();

const urls = [
  "https://www.theplayers.com/volunteer",
  "https://www.theplayers.com/",
  "https://www.theplayers.com/birdies",
  "https://www.theplayers.com/anthem",
  "https://www.theplayers.com/course",
  "https://www.theplayers.com/birdies/overview",
  "https://www.theplayers.com/equipment",
  "https://www.theplayers.com/hospitality",
  "https://www.theplayers.com/tickets/faq",
  "https://www.theplayers.com/trophy",
  "https://www.theplayers.com/news/2023/11/01/new-volunteer-registration",
  "https://www.theplayers.com/birdies/helpful-hints",
  "https://www.theplayers.com/chip-in",
  "https://www.theplayers.com/chip-in/overview",
  "https://www.theplayers.com/chip-in/leaderboard",
  "https://www.theplayers.com/fans/championship-resources",
  "https://www.theplayers.com/fans/disabled-guests",
  "https://www.theplayers.com/fans/general-information",
  "https://www.theplayers.com/fans/know-before-you-go",
  "https://www.theplayers.com/fans/ultimate-fan-guide",
  "https://www.theplayers.com/past-champions/jack-nicklaus-1974",
  "https://www.theplayers.com/past-champions/al-geiberger-1975",
  "https://www.theplayers.com/past-champions/jack-nicklaus-1976",
  "https://www.theplayers.com/past-champions/mark-hayes-1977",
  "https://www.theplayers.com/past-champions/jack-nicklaus-1978",
  "https://www.theplayers.com/past-champions/lanny-wadkins-1979",
  "https://www.theplayers.com/past-champions/lee-trevino-1980",
  "https://www.theplayers.com/past-champions/raymond-floyd-1981",
  "https://www.theplayers.com/past-champions/jerry-pate-1982",
  "https://www.theplayers.com/past-champions/hal-sutton-1983",
  "https://www.theplayers.com/past-champions/fred-couples-1984",
  "https://www.theplayers.com/past-champions/calvin-peete-1985",
  "https://www.theplayers.com/past-champions/john-mahaffey-1986",
  "https://www.theplayers.com/past-champions/sandy-lyle-1987",
  "https://www.theplayers.com/past-champions/mark-mccumber-1988",
  "https://www.theplayers.com/past-champions/tom-kite-1989",
  "https://www.theplayers.com/past-champions/jodie-mudd-1990",
  "https://www.theplayers.com/past-champions/steve-elkington-1991",
  "https://www.theplayers.com/past-champions/davis-love-1992",
  "https://www.theplayers.com/past-champions/nick-price-1993",
  "https://www.theplayers.com/past-champions/greg-norman-1994",
  "https://www.theplayers.com/past-champions/fred-couples-1996",
  "https://www.theplayers.com/past-champions/steve-elkington-1997",
  "https://www.theplayers.com/past-champions/justin-leonard-1998",
  "https://www.theplayers.com/past-champions/david-duval-1999",
  "https://www.theplayers.com/past-champions/hal-sutton-2000",
  "https://www.theplayers.com/past-champions/tiger-woods-2001",
  "https://www.theplayers.com/past-champions/craig-perks-2002",
  "https://www.theplayers.com/past-champions/davis-love-2003",
  "https://www.theplayers.com/past-champions/adam-scott-2004",
  "https://www.theplayers.com/past-champions/fred-funk-2005",
  "https://www.theplayers.com/past-champions/stephen-ames-2006",
  "https://www.theplayers.com/past-champions/phil-mickelson-2007",
  "https://www.theplayers.com/past-champions/sergio-garcia-2008",
  "https://www.theplayers.com/past-champions/henrik-stenson-2009",
  "https://www.theplayers.com/past-champions/tim-clark-2010",
  "https://www.theplayers.com/past-champions/kj-choi-2011",
  "https://www.theplayers.com/past-champions/matt-kuchar-2012",
  "https://www.theplayers.com/past-champions/tiger-woods-2013",
  "https://www.theplayers.com/past-champions/martin-kaymer-2014",
  "https://www.theplayers.com/past-champions/rickie-fowler-2015",
  "https://www.theplayers.com/past-champions/jason-day-2016",
  "https://www.theplayers.com/past-champions/si-woo-kim-2017",
  "https://www.theplayers.com/past-champions/webb-simpson-2018",
  "https://www.theplayers.com/past-champions/rory-mcilroy-2019",
  "https://www.theplayers.com/past-champions/justin-thomas-2021",
  "https://www.theplayers.com/past-champions/cameron-smith-2022",
  "https://www.theplayers.com/past-champions/scottie-scheffler-2023",
  "https://www.theplayers.com/community",
  "https://www.theplayers.com/news/2024/01/18/military-appreciation-tickets",
  "https://www.theplayers.com/military",
  "https://www.theplayers.com/tickets",
  "https://www.theplayers.com/news/2023/11/30/tickets-on-sale",
  "https://www.theplayers.com/news/2023/12/06/st-johns-county-fire-rescue-grant",
  "https://www.theplayers.com/news/2023/12/12/cole-swindell-concert-military-appreciation",
  "https://www.theplayers.com/news/2023/12/18/jacksonville-humane-society-pawsitive-reading-program",
  "https://www.theplayers.com/news/2023/12/19/the-players-gift-cummer-museum",
  "https://www.theplayers.com/news/2023/10/17/the-players-red-coat-surprises",
  "https://www.theplayers.com/news/2023/10/31/players-equipment-donation",
  "https://www.theplayers.com/news/2023/06/20/the-players-center-cancer-blood-disorders-nemours",
  "https://www.theplayers.com/volunteer/awards",
  "https://www.theplayers.com/volunteer/concessions",
  "https://www.theplayers.com/volunteer/faqs",
  "https://www.theplayers.com/volunteer/parking-shuttles",
  "https://www.theplayers.com/volunteer/party",
  "https://www.theplayers.com/volunteer/perks",
  "https://www.theplayers.com/volunteer/players-pride",
  "https://www.theplayers.com/volunteer/safety",
  "https://www.theplayers.com/volunteer/uniforms-training",
  "https://www.theplayers.com/community/grants",
  "https://www.theplayers.com/community/fundraising",
  "https://www.theplayers.com/plan-your-visit",
  "https://www.theplayers.com/parking/lot-locations",
  "https://www.theplayers.com/sustainability",
  "https://www.theplayers.com/sponsors",
  "https://www.theplayers.com/tickets/manage-tickets",
  "https://www.theplayers.com/news",
  "https://www.theplayers.com/volunteer/committees",
  "https://www.theplayers.com/volunteer/leadership",
  "https://www.theplayers.com/past-results",
  "https://www.theplayers.com/past-champions",
  "https://www.theplayers.com/news/2023/06/28/2023-red-coats-grant-program",
  "https://www.theplayers.com/news/2023/01/24/riley-green-players-military-appreciation-concert",
  "https://www.theplayers.com/news/2023/05/03/the-players-village-3-million-wolfsons-hospital",
  "https://www.theplayers.com/news/2023/05/11/hearts-4-minds-alex-newman",
  "https://www.theplayers.com/news/2023/04/18/lee-smith-named-executive-director-the-players-championship",
  "https://www.theplayers.com/news/2023/04/05/van-surprise-edward-waters-university",
  "https://www.theplayers.com/news/2023/03/13/comcast-business-named-proud-partner",
  "https://www.theplayers.com/news/2023/03/06/driving-dialogue-for-mental-health",
  "https://www.theplayers.com/news/2023/03/06/born-on-island-time",
  "https://www.theplayers.com/news/2023/03/03/final-field-the-players-2023",
  "https://www.theplayers.com/community/ticket-grant-program",
  "https://www.theplayers.com/fans/schedule-of-events",
  "https://www.theplayers.com/news/2024/02/13/profiles-fowler-aberg-morikawa-finau",
  "https://www.theplayers.com/50",
  "https://www.theplayers.com/news/2024/03/01/the-1974-tournament-players-championship",
  "https://www.theplayers.com/news/2024/02/19/profiles-mcilroy-fleetwood-hovland-hojgaard",
  "https://www.theplayers.com/fan-shop",
  "https://www.theplayers.com/news/2024/02/27/profiles-thomas-spieth-homa-dunlap",
  "https://www.theplayers.com/news/2024/02/28/general-parking-friday-sold-out",
  "https://www.theplayers.com/parking",
  "https://www.theplayers.com/news/2024/03/06/scheffler-schauffele-clark-bhatia",
  "https://www.theplayers.com/news/2024/03/08/final-field",
  "https://www.theplayers.com/news/2024/03/10/nemours-childrens-health-youth-sponsor",
  "https://www.theplayers.com/news/2024/03/12/deane-and-judy-beman-players-championship-memories",
  "https://www.theplayers.com/news/2024/03/12/chris-duke-players-championship-portraits",
  "https://www.theplayers.com/news/2024/03/13/commemorative-onesies",
  "https://www.theplayers.com/50gold-sweepstakes",
  "https://www.theplayers.com/news/2024/03/15/saturday-sold-out",
  "https://www.theplayers.com/news/2024/05/10/community-grant-program-national-golf-day",
  "https://www.theplayers.com/news/2024/06/13/special-olympics-northeast-florida-the-players-championship",
  "https://www.theplayers.com/news/2024/09/10/the-players-championship-2024-red-coats-community-grants-recipients",
  "https://www.theplayers.com/news/2024/09/25/the-players-announced-fifty-thousand-grant-local-non-profits",
  "https://www.theplayers.com/news/2024/11/06/volunteer-registration-open-the-players-championhip-2025",
  "https://www.theplayers.com/news/2024/11/11/the-players-announces-open-auditions-national-anthem-performers",
  "https://www.theplayers.com/news/2024/12/05/tickets-for-the-players-championship-2025-now-on-sale",
  "https://www.theplayers.com/news/2025/01/14/jordan-davis-military-appreciation-concert-tpc-sawgrass",
  "https://www.theplayers.com/news/2025/01/22/the-players-championship-invests-in-boys-girls-club-northeast-florida",
  "https://www.theplayers.com/creator-classic",
  "https://www.theplayers.com/news/2025/02/12/players-profiles-adam-scott-minwoo-lee-hideki-matsuyama-justin-rose",
  "https://www.theplayers.com/news/2025/02/18/the-players-profiles-justin-thomas-max-homa-rickie-fowler-collin-morikawa",
  "https://www.theplayers.com/news/2025/02/19/format-field-creator-classic-tpc-sawgrass",
  "https://www.theplayers.com/news/2025/02/26/the-players-profiles-rory-mcilroy-jason-day-patrick-cantlay-viktor-hovland",
];

for (const url of urls) {
  try {
    const resp = await fetch(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${process.env.GOOGLE_CRUX_API_KEY}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formFactor: 'DESKTOP',
        metrics: [
          'largest_contentful_paint',
          'cumulative_layout_shift',
          'interaction_to_next_paint'
        ]
      }),
    });

    if (resp.status === 404) {
      continue;
    }

    const json = await resp.json();
    const entries = Object.entries(json.record.metrics);
    console.log(url);
    let isNotGood = false;
    for (const [k, v] of entries) {
      if (k === 'largest_contentful_paint' && v.percentiles.p75 >= 2500) {
        isNotGood = true;
        console.log('  - ', k, v.percentiles.p75);
      }
      if (k === 'interaction_to_next_paint' && v.percentiles.p75 >= 200) {
        isNotGood = true;
        console.log('  - ', k, v.percentiles.p75);
      }
      if (k === 'cumulative_layout_shift' && v.percentiles.p75 >= 0.01) {
        isNotGood = true;
        console.log('  - ', k, v.percentiles.p75);
      }
    };
  } catch (err) {
    console.log(url, err);
  }
}
