import {
  Callout,
  CollapsibleSection,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Link,
  Pill,
  Row,
  Spacer,
  Stack,
  Stat,
  Table,
  Text,
} from 'cursor/canvas';

const GENERATED_AT = "2026-06-19T17:46:47.592506Z";
const TWITCH_CLIPS = 30537;
const TWITCH_CHANNEL_COUNT = 15397;
const TWITCH_GAMES = 500;
const KICK_DISCOVERED = 2371;
const KICK_CLIPS = 729;
const KICK_CHANNEL_COUNT = 110;
const KICK_SCRAPE_ERRORS = 1995;

const TWITCH_TOP_CLIPS = [
  {"rank": 1, "streamer": "wakewilder", "views": 27084, "duration": 39, "game": "Just Chatting", "title": ".", "url": "https://www.twitch.tv/wakewilder/clip/SplendidSuavePandaPanicVis-pTZR1Vo2MDgcR8Q2"},
  {"rank": 2, "streamer": "Grubby", "views": 10305, "duration": 59, "game": "Age of Empires II", "title": "For Frodo!", "url": "https://www.twitch.tv/grubby/clip/PuzzledShinyOrcaTBCheesePull-YoKwlAa-N39LZnDq"},
  {"rank": 3, "streamer": "sodapoppin", "views": 9646, "duration": 9, "game": "World of Warcraft", "title": "NOW", "url": "https://www.twitch.tv/sodapoppin/clip/BenevolentSnappyTermitePogChamp-Rso3tl9iSv0F4M3D"},
  {"rank": 4, "streamer": "ESLCS", "views": 9182, "duration": 30, "game": "Counter-Strike", "title": "LMFAOO", "url": "https://www.twitch.tv/eslcs/clip/LazyTangentialZucchiniKlappa-tnecyFnfV_PyyQb0"},
  {"rank": 5, "streamer": "えびすくん", "views": 8743, "duration": 39, "game": "Grand Theft Auto V", "title": "よく会うなー、え、何人いる？868人います？w", "url": "https://www.twitch.tv/minioni3202/clip/PreciousHonestSoybeanStinkyCheese-OXdgKc4Ef1Dpby80"},
  {"rank": 6, "streamer": "ohnePixel", "views": 7425, "duration": 26, "game": "Counter-Strike", "title": "xdddd", "url": "https://www.twitch.tv/ohnepixel/clip/TemperedSmoothAsparagusDoritosChip-iRWVCnQ6eFiYghrn"},
  {"rank": 7, "streamer": "えびすくん", "views": 7217, "duration": 60, "game": "Grand Theft Auto V", "title": "街を歩けば868に出会うえびす", "url": "https://www.twitch.tv/minioni3202/clip/DelightfulWonderfulAnacondaAMPEnergyCherry-uLzXciYey4usBBBx"},
  {"rank": 8, "streamer": "enzzai", "views": 6517, "duration": 13, "game": "Just Chatting", "title": "Завоз от Огра", "url": "https://www.twitch.tv/enzzai/clip/PhilanthropicRacyVampirePhilosoraptor-KnGQKCHkI53QPglt"},
  {"rank": 9, "streamer": "DrDonutttttt", "views": 5676, "duration": 38, "game": "Minecraft", "title": "I HAD A TOTEM", "url": "https://www.twitch.tv/drdonutttttt/clip/SpoopyKindWolverineItsBoshyTime-c95t6fKoAGqYd0lH"},
  {"rank": 10, "streamer": "えびすくん", "views": 5519, "duration": 60, "game": "Grand Theft Auto V", "title": "音鳴ミックスとピクニック「あぁー、おもろw」", "url": "https://www.twitch.tv/minioni3202/clip/AgitatedHandsomeOcelotPastaThat-NoQ9C79ko4b5zBfk"},
  {"rank": 11, "streamer": "ゆーじお", "views": 5480, "duration": 17, "game": "League of Legends", "title": "こんなにかわいいめあたむ知らない", "url": "https://www.twitch.tv/eugeoja/clip/SpinelessRamshackleSpaghettiPMSTwin-4LqP1YAbKU6uLXpL"},
  {"rank": 12, "streamer": "singsing", "views": 5385, "duration": 60, "game": "Age of Empires II", "title": "Very calm game", "url": "https://www.twitch.tv/singsing/clip/BitterMoldyBaboonOMGScoots-wL1J5EThesMoA0n2"},
  {"rank": 13, "streamer": "しーあーるとっぴー", "views": 4177, "duration": 60, "game": "Grand Theft Auto V", "title": "聞かれるまで言わない観測者さんたち", "url": "https://www.twitch.tv/crtopioxd/clip/SucculentTrappedDumplingsCoolStoryBob-mpubJMNoJbRyYmUV"},
  {"rank": 14, "streamer": "CroissantStrike", "views": 4097, "duration": 40, "game": "Counter-Strike", "title": "ohnePixel throws vape at French casters", "url": "https://www.twitch.tv/croissantstrike/clip/CreativeCaringCiderJKanStyle-88S01BSGuV7dDF_U"},
  {"rank": 15, "streamer": "ととみっくす", "views": 3904, "duration": 60, "game": "Grand Theft Auto V", "title": "えびす「ここら辺で置き配泥棒が多いんですよ。」", "url": "https://www.twitch.tv/tototmix/clip/FaintCooperativeGarlicTF2John-7W1Udv3di6dyuFOY"},
  {"rank": 16, "streamer": "CroissantStrike", "views": 3731, "duration": 19, "game": "Counter-Strike", "title": "Il pleut à Cologne", "url": "https://www.twitch.tv/croissantstrike/clip/MoistPoorMochaEagleEye-RO4HohdElsJjkceQ"},
  {"rank": 17, "streamer": "Yugi2x", "views": 3528, "duration": 8, "game": "Just Chatting", "title": "Stay in school", "url": "https://www.twitch.tv/yugi2x/clip/AuspiciousLazyMeatloafYee-fKJ9kqOoBRYD_FgX"},
  {"rank": 18, "streamer": "SCHRADIN", "views": 3331, "duration": 60, "game": "IRL", "title": "Schradin malt Rose", "url": "https://www.twitch.tv/schradin/clip/GiantEmpathicDolphinBleedPurple-Dl0q7j8zxcQKKEpw"},
  {"rank": 19, "streamer": "MissMikkaa", "views": 3094, "duration": 60, "game": "Burglin' Gnomes", "title": "DEAD BODY NUDITY!!!!", "url": "https://www.twitch.tv/missmikkaa/clip/EmpathicLightFishCoolStoryBro-fB8bYxVf9AGmF46i"},
  {"rank": 20, "streamer": "えびすくん", "views": 2943, "duration": 60, "game": "Grand Theft Auto V", "title": "どこ住み？関東？護衛しようか？w", "url": "https://www.twitch.tv/minioni3202/clip/RealOptimisticEggnogVoteYea-G-WVWHEQzKM7acbf"},
  {"rank": 21, "streamer": "fubgun", "views": 2943, "duration": 19, "game": "Path of Exile 2", "title": "Mageblood 8", "url": "https://www.twitch.tv/fubgun/clip/KitschyUglyCarabeefPraiseIt-OBsJDlwiqP7rIZ5q"},
  {"rank": 22, "streamer": "forsen", "views": 2697, "duration": 59, "game": "Dead by Daylight", "title": "Global Elite", "url": "https://www.twitch.tv/forsen/clip/WimpySteamySandwichNerfRedBlaster-GIXT5Ho29XzgVQON"},
  {"rank": 23, "streamer": "切嘛", "views": 2620, "duration": 60, "game": "Grand Theft Auto V", "title": "会長がおるだけでおもろくて咽せるジョシュア", "url": "https://www.twitch.tv/kiruma_ch/clip/ShinyGlutenFreeDunlinSeemsGood-_1mh86hC8QA803cv"},
  {"rank": 24, "streamer": "ESLCS", "views": 2452, "duration": 60, "game": "Counter-Strike", "title": "molodoy - 1vs3 AWP clutch (T - bomb planted after 2 clutch kills)", "url": "https://www.twitch.tv/eslcs/clip/RockyVenomousReindeerSMOrc-upW2ujttJsve0UFo"},
  {"rank": 25, "streamer": "しーあーるとっぴー", "views": 2409, "duration": 50, "game": "Grand Theft Auto V", "title": "さりげなくちゃんとギャング", "url": "https://www.twitch.tv/crtopioxd/clip/InquisitiveGleamingOxAMPEnergy-w4xqdWwKSeKzhtIT"},
  {"rank": 26, "streamer": "SMii7Y", "views": 2373, "duration": 15, "game": "Backrooms Lost Runners", "title": "ill just die", "url": "https://www.twitch.tv/smii7y/clip/PreciousNastyPangolinKreygasm-2za0nNqVUx8TH0rk"},
  {"rank": 27, "streamer": "Twistey", "views": 2250, "duration": 22, "game": "Deadlock", "title": "Kultist I | Viel luft nach oben...", "url": "https://www.twitch.tv/twistey/clip/CautiousBetterElephantDxCat-ATeCfeJ933ZIFR88"},
  {"rank": 28, "streamer": "henry_8492", "views": 2240, "duration": 41, "game": "Grand Theft Auto V", "title": "武器屋の護衛に名があがるえいみつ", "url": "https://www.twitch.tv/henry_8492/clip/FrigidCooperativeNewtNotATK-rRy-xLcg-8liJ2nQ"},
  {"rank": 29, "streamer": "YamatoCannon", "views": 2206, "duration": 16, "game": "Age of Empires II", "title": "day9 is gonna smoke grubby", "url": "https://www.twitch.tv/yamatocannon/clip/SlipperyPlainCrocodilePoooound-wdijO2A0XhTecFRb"},
  {"rank": 30, "streamer": "ESLCS", "views": 2184, "duration": 53, "game": "Counter-Strike", "title": "yuurih - 1vs4 clutch (T - bomb planted after 3 clutch kills) - Part 2 - 1/4 frags", "url": "https://www.twitch.tv/eslcs/clip/EndearingCogentPepperTinyFace-HjM2WarlS81PdF2o"},
  {"rank": 31, "streamer": "xRohat", "views": 2174, "duration": 30, "game": "Just Chatting", "title": "😂😂😂", "url": "https://www.twitch.tv/xrohat/clip/CrypticNaiveLadiesSoonerLater-dprtOyiPJ_yAirP7"},
  {"rank": 32, "streamer": "rosha_29", "views": 2155, "duration": 8, "game": "Counter-Strike", "title": "монитор обрызгал", "url": "https://www.twitch.tv/rosha_29/clip/SpinelessTameCroissantFunRun-OT5vsotzfFIQ7qKv"},
  {"rank": 33, "streamer": "あくあ_", "views": 2106, "duration": 60, "game": "Street Fighter 6", "title": "叶さんうまい！アルマス伊達じゃねぇなぁ", "url": "https://www.twitch.tv/acqua_0316/clip/FunEncouragingTigerFutureMan-D4ClWn_tyxmudl0I"},
  {"rank": 34, "streamer": "tylil", "views": 2084, "duration": 30, "game": "IRL", "title": "👀", "url": "https://www.twitch.tv/tylil/clip/CreativeBeautifulGazelleTBTacoLeft-agTaZramCTB4ycJ9"},
  {"rank": 35, "streamer": "ajak0n", "views": 2050, "duration": 38, "game": "Grand Theft Auto V", "title": "右よーし　左よーし出発ーー", "url": "https://www.twitch.tv/ajak0n/clip/UninterestedRamshackleDuckPanicVis-b3UWwgljsgvLSlS3"},
  {"rank": 36, "streamer": "ESLCS", "views": 1987, "duration": 57, "game": "Counter-Strike", "title": "yuurih - 1vs4 clutch (T - bomb planted after 3 clutch kills) - Part 1 - 3/4 frags", "url": "https://www.twitch.tv/eslcs/clip/EsteemedExuberantHerbsLitFam-7i3m8hb0hZdwDDIL"},
  {"rank": 37, "streamer": "Hera", "views": 1987, "duration": 38, "game": "Age of Empires II", "title": "The King's Gauntlet game of the tournament!", "url": "https://www.twitch.tv/hera/clip/BraveCaringGarbageCoolCat-Sq8SaBZDKoa_aage"},
  {"rank": 38, "streamer": "Twistey", "views": 1960, "duration": 15, "game": "Deadlock", "title": "Es nervt so hart...", "url": "https://www.twitch.tv/twistey/clip/RelievedSingleFriseeCharlieBitMe-Bn98NFvqh6Z1dn9J"},
  {"rank": 39, "streamer": "PIRA_real", "views": 1932, "duration": 14, "game": "Grand Theft Auto V", "title": "柚麦とと「言って？行くとき」", "url": "https://www.twitch.tv/pira_real/clip/ShakingProudScallionNotLikeThis-VE4YK2QFLshGTsqV"},
  {"rank": 40, "streamer": "kokujintv", "views": 1902, "duration": 18, "game": "League of Legends", "title": "4v5 1AFK", "url": "https://www.twitch.tv/kokujintv/clip/TsundereLitigiousVanillaFUNgineer-qemaWFef0OJ2CzT-"},
  {"rank": 41, "streamer": "Aryssa614", "views": 1829, "duration": 19, "game": "Just Chatting", "title": "cute playtime <3", "url": "https://www.twitch.tv/aryssa614/clip/KitschyBillowingFoxImGlitch-jYrGmW7p_Eb3Rypc"},
  {"rank": 42, "streamer": "Shiron103", "views": 1814, "duration": 42, "game": "Grand Theft Auto V", "title": "初犯の為プリズンを免れたあげころにツッコむ葛城", "url": "https://www.twitch.tv/shiron103/clip/SpoopyBrainyNewtOptimizePrime-vZkIRfc4ACI5-h5w"},
  {"rank": 43, "streamer": "enzzai", "views": 1807, "duration": 30, "game": "Just Chatting", "title": "НАПРЯГ ВЛОВЕСА ОТ ЗДРАВОГО АТЛЕТА", "url": "https://www.twitch.tv/enzzai/clip/AgileMistyWaffleCorgiDerp-VLN3EOUeHgZik0wB"},
  {"rank": 44, "streamer": "PGL_Dota2", "views": 1773, "duration": 60, "game": "Dota 2", "title": "Scofield showing his power", "url": "https://www.twitch.tv/pgl_dota2/clip/CooperativeCourageousRadishMikeHogu-4FVXvDQCykFPDNYe"},
  {"rank": 45, "streamer": "jasontheween", "views": 1770, "duration": 34, "game": "Just Chatting", "title": "Jason and Marlon encountered a tweaker in New York", "url": "https://www.twitch.tv/jasontheween/clip/NeighborlySwissClamGOWSkull-r-vhhAm6HGNsfDS5"},
  {"rank": 46, "streamer": "ohnePixel", "views": 1729, "duration": 16, "game": "Counter-Strike", "title": "irl dick pattern?", "url": "https://www.twitch.tv/ohnepixel/clip/AmazonianSaltyCheesecakeOptimizePrime-1gStM0nnQnDt3csf"},
  {"rank": 47, "streamer": "Sardaco", "views": 1724, "duration": 18, "game": "Old School RuneScape", "title": "Kodai!", "url": "https://www.twitch.tv/sardaco/clip/PhilanthropicSullenCurlewCmonBruh-ivJ0VTe5zVi5vmv8"},
  {"rank": 48, "streamer": "がーどまん", "views": 1707, "duration": 30, "game": "IRL", "title": "カスがいた電話", "url": "https://www.twitch.tv/gardman666/clip/ConsiderateInnocentQueleaBlargNaut-8XbVrfZAR5uelN9v"},
  {"rank": 49, "streamer": "ESLCS", "views": 1687, "duration": 38, "game": "Counter-Strike", "title": "Max 2 v 1 against Furia to win map 1", "url": "https://www.twitch.tv/eslcs/clip/AmorphousGentleOrcaHassaanChop-UD4c6y49VyUqQCdt"},
  {"rank": 50, "streamer": "ESLCS", "views": 1625, "duration": 55, "game": "Counter-Strike", "title": "yuurih - 1vs3 clutch (T - bomb planted after 2 clutch kills) - Part 1", "url": "https://www.twitch.tv/eslcs/clip/ShyObservantDelicataHeyGuys-rgmZbRaRClG0bYq-"},
];
const TWITCH_TOP_CHANNELS = [
  {"rank": 1, "streamer": "wakewilder", "login": "wakewilder", "views": 27084, "clipCount": 1, "title": ".", "url": "https://www.twitch.tv/wakewilder/clip/SplendidSuavePandaPanicVis-pTZR1Vo2MDgcR8Q2"},
  {"rank": 2, "streamer": "Grubby", "login": "grubby", "views": 10305, "clipCount": 7, "title": "For Frodo!", "url": "https://www.twitch.tv/grubby/clip/PuzzledShinyOrcaTBCheesePull-YoKwlAa-N39LZnDq"},
  {"rank": 3, "streamer": "sodapoppin", "login": "sodapoppin", "views": 9646, "clipCount": 10, "title": "NOW", "url": "https://www.twitch.tv/sodapoppin/clip/BenevolentSnappyTermitePogChamp-Rso3tl9iSv0F4M3D"},
  {"rank": 4, "streamer": "ESLCS", "login": "eslcs", "views": 9182, "clipCount": 37, "title": "LMFAOO", "url": "https://www.twitch.tv/eslcs/clip/LazyTangentialZucchiniKlappa-tnecyFnfV_PyyQb0"},
  {"rank": 5, "streamer": "えびすくん", "login": "えびすくん", "views": 8743, "clipCount": 10, "title": "よく会うなー、え、何人いる？868人います？w", "url": "https://www.twitch.tv/minioni3202/clip/PreciousHonestSoybeanStinkyCheese-OXdgKc4Ef1Dpby80"},
  {"rank": 6, "streamer": "ohnePixel", "login": "ohnepixel", "views": 7425, "clipCount": 8, "title": "xdddd", "url": "https://www.twitch.tv/ohnepixel/clip/TemperedSmoothAsparagusDoritosChip-iRWVCnQ6eFiYghrn"},
  {"rank": 7, "streamer": "enzzai", "login": "enzzai", "views": 6517, "clipCount": 41, "title": "Завоз от Огра", "url": "https://www.twitch.tv/enzzai/clip/PhilanthropicRacyVampirePhilosoraptor-KnGQKCHkI53QPglt"},
  {"rank": 8, "streamer": "DrDonutttttt", "login": "drdonutttttt", "views": 5676, "clipCount": 3, "title": "I HAD A TOTEM", "url": "https://www.twitch.tv/drdonutttttt/clip/SpoopyKindWolverineItsBoshyTime-c95t6fKoAGqYd0lH"},
  {"rank": 9, "streamer": "ゆーじお", "login": "ゆーじお", "views": 5480, "clipCount": 2, "title": "こんなにかわいいめあたむ知らない", "url": "https://www.twitch.tv/eugeoja/clip/SpinelessRamshackleSpaghettiPMSTwin-4LqP1YAbKU6uLXpL"},
  {"rank": 10, "streamer": "singsing", "login": "singsing", "views": 5385, "clipCount": 9, "title": "Very calm game", "url": "https://www.twitch.tv/singsing/clip/BitterMoldyBaboonOMGScoots-wL1J5EThesMoA0n2"},
  {"rank": 11, "streamer": "しーあーるとっぴー", "login": "しーあーるとっぴー", "views": 4177, "clipCount": 4, "title": "聞かれるまで言わない観測者さんたち", "url": "https://www.twitch.tv/crtopioxd/clip/SucculentTrappedDumplingsCoolStoryBob-mpubJMNoJbRyYmUV"},
  {"rank": 12, "streamer": "CroissantStrike", "login": "croissantstrike", "views": 4097, "clipCount": 4, "title": "ohnePixel throws vape at French casters", "url": "https://www.twitch.tv/croissantstrike/clip/CreativeCaringCiderJKanStyle-88S01BSGuV7dDF_U"},
  {"rank": 13, "streamer": "ととみっくす", "login": "ととみっくす", "views": 3904, "clipCount": 1, "title": "えびす「ここら辺で置き配泥棒が多いんですよ。」", "url": "https://www.twitch.tv/tototmix/clip/FaintCooperativeGarlicTF2John-7W1Udv3di6dyuFOY"},
  {"rank": 14, "streamer": "Yugi2x", "login": "yugi2x", "views": 3528, "clipCount": 1, "title": "Stay in school", "url": "https://www.twitch.tv/yugi2x/clip/AuspiciousLazyMeatloafYee-fKJ9kqOoBRYD_FgX"},
  {"rank": 15, "streamer": "SCHRADIN", "login": "schradin", "views": 3331, "clipCount": 5, "title": "Schradin malt Rose", "url": "https://www.twitch.tv/schradin/clip/GiantEmpathicDolphinBleedPurple-Dl0q7j8zxcQKKEpw"},
  {"rank": 16, "streamer": "MissMikkaa", "login": "missmikkaa", "views": 3094, "clipCount": 8, "title": "DEAD BODY NUDITY!!!!", "url": "https://www.twitch.tv/missmikkaa/clip/EmpathicLightFishCoolStoryBro-fB8bYxVf9AGmF46i"},
  {"rank": 17, "streamer": "fubgun", "login": "fubgun", "views": 2943, "clipCount": 10, "title": "Mageblood 8", "url": "https://www.twitch.tv/fubgun/clip/KitschyUglyCarabeefPraiseIt-OBsJDlwiqP7rIZ5q"},
  {"rank": 18, "streamer": "forsen", "login": "forsen", "views": 2697, "clipCount": 3, "title": "Global Elite", "url": "https://www.twitch.tv/forsen/clip/WimpySteamySandwichNerfRedBlaster-GIXT5Ho29XzgVQON"},
  {"rank": 19, "streamer": "切嘛", "login": "切嘛", "views": 2620, "clipCount": 11, "title": "会長がおるだけでおもろくて咽せるジョシュア", "url": "https://www.twitch.tv/kiruma_ch/clip/ShinyGlutenFreeDunlinSeemsGood-_1mh86hC8QA803cv"},
  {"rank": 20, "streamer": "SMii7Y", "login": "smii7y", "views": 2373, "clipCount": 22, "title": "ill just die", "url": "https://www.twitch.tv/smii7y/clip/PreciousNastyPangolinKreygasm-2za0nNqVUx8TH0rk"},
  {"rank": 21, "streamer": "Twistey", "login": "twistey", "views": 2250, "clipCount": 2, "title": "Kultist I | Viel luft nach oben...", "url": "https://www.twitch.tv/twistey/clip/CautiousBetterElephantDxCat-ATeCfeJ933ZIFR88"},
  {"rank": 22, "streamer": "henry_8492", "login": "henry_8492", "views": 2240, "clipCount": 3, "title": "武器屋の護衛に名があがるえいみつ", "url": "https://www.twitch.tv/henry_8492/clip/FrigidCooperativeNewtNotATK-rRy-xLcg-8liJ2nQ"},
  {"rank": 23, "streamer": "YamatoCannon", "login": "yamatocannon", "views": 2206, "clipCount": 2, "title": "day9 is gonna smoke grubby", "url": "https://www.twitch.tv/yamatocannon/clip/SlipperyPlainCrocodilePoooound-wdijO2A0XhTecFRb"},
  {"rank": 24, "streamer": "xRohat", "login": "xrohat", "views": 2174, "clipCount": 1, "title": "😂😂😂", "url": "https://www.twitch.tv/xrohat/clip/CrypticNaiveLadiesSoonerLater-dprtOyiPJ_yAirP7"},
  {"rank": 25, "streamer": "rosha_29", "login": "rosha_29", "views": 2155, "clipCount": 3, "title": "монитор обрызгал", "url": "https://www.twitch.tv/rosha_29/clip/SpinelessTameCroissantFunRun-OT5vsotzfFIQ7qKv"},
  {"rank": 26, "streamer": "あくあ_", "login": "あくあ_", "views": 2106, "clipCount": 4, "title": "叶さんうまい！アルマス伊達じゃねぇなぁ", "url": "https://www.twitch.tv/acqua_0316/clip/FunEncouragingTigerFutureMan-D4ClWn_tyxmudl0I"},
  {"rank": 27, "streamer": "tylil", "login": "tylil", "views": 2084, "clipCount": 6, "title": "👀", "url": "https://www.twitch.tv/tylil/clip/CreativeBeautifulGazelleTBTacoLeft-agTaZramCTB4ycJ9"},
  {"rank": 28, "streamer": "ajak0n", "login": "ajak0n", "views": 2050, "clipCount": 11, "title": "右よーし　左よーし出発ーー", "url": "https://www.twitch.tv/ajak0n/clip/UninterestedRamshackleDuckPanicVis-b3UWwgljsgvLSlS3"},
  {"rank": 29, "streamer": "Hera", "login": "hera", "views": 1987, "clipCount": 32, "title": "The King's Gauntlet game of the tournament!", "url": "https://www.twitch.tv/hera/clip/BraveCaringGarbageCoolCat-Sq8SaBZDKoa_aage"},
  {"rank": 30, "streamer": "PIRA_real", "login": "pira_real", "views": 1932, "clipCount": 6, "title": "柚麦とと「言って？行くとき」", "url": "https://www.twitch.tv/pira_real/clip/ShakingProudScallionNotLikeThis-VE4YK2QFLshGTsqV"},
  {"rank": 31, "streamer": "kokujintv", "login": "kokujintv", "views": 1902, "clipCount": 2, "title": "4v5 1AFK", "url": "https://www.twitch.tv/kokujintv/clip/TsundereLitigiousVanillaFUNgineer-qemaWFef0OJ2CzT-"},
  {"rank": 32, "streamer": "Aryssa614", "login": "aryssa614", "views": 1829, "clipCount": 1, "title": "cute playtime <3", "url": "https://www.twitch.tv/aryssa614/clip/KitschyBillowingFoxImGlitch-jYrGmW7p_Eb3Rypc"},
  {"rank": 33, "streamer": "Shiron103", "login": "shiron103", "views": 1814, "clipCount": 1, "title": "初犯の為プリズンを免れたあげころにツッコむ葛城", "url": "https://www.twitch.tv/shiron103/clip/SpoopyBrainyNewtOptimizePrime-vZkIRfc4ACI5-h5w"},
  {"rank": 34, "streamer": "PGL_Dota2", "login": "pgl_dota2", "views": 1773, "clipCount": 2, "title": "Scofield showing his power", "url": "https://www.twitch.tv/pgl_dota2/clip/CooperativeCourageousRadishMikeHogu-4FVXvDQCykFPDNYe"},
  {"rank": 35, "streamer": "jasontheween", "login": "jasontheween", "views": 1770, "clipCount": 2, "title": "Jason and Marlon encountered a tweaker in New York", "url": "https://www.twitch.tv/jasontheween/clip/NeighborlySwissClamGOWSkull-r-vhhAm6HGNsfDS5"},
  {"rank": 36, "streamer": "Sardaco", "login": "sardaco", "views": 1724, "clipCount": 2, "title": "Kodai!", "url": "https://www.twitch.tv/sardaco/clip/PhilanthropicSullenCurlewCmonBruh-ivJ0VTe5zVi5vmv8"},
  {"rank": 37, "streamer": "がーどまん", "login": "がーどまん", "views": 1707, "clipCount": 3, "title": "カスがいた電話", "url": "https://www.twitch.tv/gardman666/clip/ConsiderateInnocentQueleaBlargNaut-8XbVrfZAR5uelN9v"},
  {"rank": 38, "streamer": "shadowkekw", "login": "shadowkekw", "views": 1604, "clipCount": 3, "title": "ГАЕЧКА ЖЕСТКО ПРО ШАДОУКЕКА", "url": "https://www.twitch.tv/shadowkekw/clip/BelovedDoubtfulGiraffePhilosoraptor-IUHwwJGXw42Rfa-k"},
  {"rank": 39, "streamer": "caseoh_", "login": "caseoh_", "views": 1589, "clipCount": 8, "title": "“Chris Plumbfeild”😂😂😂GOTY!🔥", "url": "https://www.twitch.tv/caseoh_/clip/RepleteFurtiveApePMSTwin-OxF2dgFUpcnDsnn0"},
  {"rank": 40, "streamer": "thoot", "login": "thoot", "views": 1581, "clipCount": 2, "title": "Best Female Valorant Player #6k #ImmortalAce", "url": "https://www.twitch.tv/thoot/clip/AnnoyingColdbloodedDragonflyKevinTurtle-gLNbwXKVqWMK2ecG"},
  {"rank": 41, "streamer": "Waolol1", "login": "waolol1", "views": 1580, "clipCount": 1, "title": "WAO TUTUTUTUTTUTUTUUTUT", "url": "https://www.twitch.tv/waolol1/clip/CuteDifficultChinchillaFreakinStinkin-66Ttuoq6o5UqlXOv"},
  {"rank": 42, "streamer": "erobb221", "login": "erobb221", "views": 1548, "clipCount": 3, "title": "erob is done with science", "url": "https://www.twitch.tv/erobb221/clip/SingleSpookyMulePlanking-HxiOh5ODXi3ryaEb"},
  {"rank": 43, "streamer": "ありさか", "login": "ありさか", "views": 1527, "clipCount": 16, "title": "最強のチャージャー使いが来ると聞いていたが・・・", "url": "https://www.twitch.tv/cr_arisakaaa/clip/GoldenSmilingMeerkatM4xHeh-uYRNvHibANEt9rRW"},
  {"rank": 44, "streamer": "Squeex", "login": "squeex", "views": 1504, "clipCount": 4, "title": "Squeex, Lud, and Fuslie work together", "url": "https://www.twitch.tv/squeex/clip/RelievedVainGrouseWoofer-Pc7mAiXXXXeRbuPm"},
  {"rank": 45, "streamer": "meetenshow", "login": "meetenshow", "views": 1503, "clipCount": 2, "title": "Не взяла, А обняла", "url": "https://www.twitch.tv/meetenshow/clip/SpikyCrunchyWolfRlyTho-KlYBNcnbgZXUhmmd"},
  {"rank": 46, "streamer": "Minpojke", "login": "minpojke", "views": 1439, "clipCount": 1, "title": "Most INSANE Macestun ever?", "url": "https://www.twitch.tv/minpojke/clip/GrossGiftedTortoiseDancingBaby-Dn0lpTOMAL-Huyji"},
  {"rank": 47, "streamer": "RavshanN", "login": "ravshann", "views": 1378, "clipCount": 1, "title": "VOLVA", "url": "https://www.twitch.tv/ravshann/clip/HonorableConcernedPepperoniRlyTho-wQE8TcI3oomEyafe"},
  {"rank": 48, "streamer": "Guzu", "login": "guzu", "views": 1309, "clipCount": 2, "title": "How to join SoD Event", "url": "https://www.twitch.tv/guzu/clip/WrongObservantShrimpAMPTropPunch-ouVK79iTM1ZgjcJM"},
  {"rank": 49, "streamer": "nenormova", "login": "nenormova", "views": 1305, "clipCount": 50, "title": "Мелхарус и фиаско", "url": "https://www.twitch.tv/nenormova/clip/PlayfulAwkwardAlfalfaNotATK-vUHcNwbJI6g8cqPD"},
  {"rank": 50, "streamer": "marunnn_", "login": "marunnn_", "views": 1295, "clipCount": 5, "title": "みんな花の名前に職質したら撃たれるぞ！気を付けろ！", "url": "https://www.twitch.tv/marunnn_/clip/CorrectVastMouseSeemsGood-XYVSgl6bVGYzmiDF"},
];
const KICK_TOP_CLIPS = [
  {"rank": 1, "streamer": "azdus", "views": 1347, "duration": 26, "game": "Just Chatting", "title": "Wyznanie miłości", "url": "https://kick.com/azdus/clips/clip_01KVF56AVR5KXDFZBYETYX766F"},
  {"rank": 2, "streamer": "aktor", "views": 1155, "duration": 73, "game": "IRL", "title": "RIZZ NA AZJATCE +20 PUNKTÓW", "url": "https://kick.com/aktor/clips/clip_01KVG7XHCF05YD1CK126P9SFVW"},
  {"rank": 3, "streamer": "8bit_goldy", "views": 724, "duration": 30, "game": "Grand Theft Auto V (GTA)", "title": "W dada <3", "url": "https://kick.com/8bit_goldy/clips/clip_01KVFCDFM5ECMG1G90XX1FZ256"},
  {"rank": 4, "streamer": "8bit_goldy", "views": 616, "duration": 60, "game": "Grand Theft Auto V (GTA)", "title": "crazy entry", "url": "https://kick.com/8bit_goldy/clips/clip_01KVF0R68ZPJCGYJ7YGHW4WGX2"},
  {"rank": 5, "streamer": "8bit_goldy", "views": 413, "duration": 60, "game": "Grand Theft Auto V (GTA)", "title": "unique toh ha", "url": "https://kick.com/8bit_goldy/clips/clip_01KVF5JK89PA2QGC7H1WF5N0FM"},
  {"rank": 6, "streamer": "8bit_rusherwow", "views": 301, "duration": 34, "game": "Grand Theft Auto V (GTA)", "title": "Efforts to hain 😀", "url": "https://kick.com/8bit_rusherwow/clips/clip_01KVFEXMXKYXGCFW20GGV8Y63F"},
  {"rank": 7, "streamer": "buerolol", "views": 210, "duration": 36, "game": "League of Legends", "title": "kkkk lavagem de dinheiro ?", "url": "https://kick.com/buerolol/clips/clip_01KVEGTNCDM4MDX06Y0PZ3M1DS"},
  {"rank": 8, "streamer": "8bit_goldy", "views": 209, "duration": 30, "game": "Grand Theft Auto V (GTA)", "title": "reason", "url": "https://kick.com/8bit_goldy/clips/clip_01KVG7WFVKW1YMWA5V085BT8NA"},
  {"rank": 9, "streamer": "8bit_goldy", "views": 207, "duration": 47, "game": "Grand Theft Auto V (GTA)", "title": "..", "url": "https://kick.com/8bit_goldy/clips/clip_01KVG7KSJDWMFY0A06BDJ6M5KC"},
  {"rank": 10, "streamer": "azdus", "views": 196, "duration": 11, "game": "IRL", "title": "robak wchodzi do majtek yomis", "url": "https://kick.com/azdus/clips/clip_01KVGESV008DE5TQM8DWYVZVB3"},
  {"rank": 11, "streamer": "8bitheadflicker", "views": 185, "duration": 60, "game": "Grand Theft Auto V (GTA)", "title": "Turtle", "url": "https://kick.com/8bitheadflicker/clips/clip_01KVFJWYE9VM6CWVRGJC2TB1S0"},
  {"rank": 12, "streamer": "azdus", "views": 148, "duration": 30, "game": "IRL", "title": "Prześwitujące spodnie", "url": "https://kick.com/azdus/clips/clip_01KVG33J29XDR0431GQV92EJRP"},
  {"rank": 13, "streamer": "bundachiara", "views": 129, "duration": 30, "game": "IRL", "title": "smheininki", "url": "https://kick.com/bundachiara/clips/clip_01KVG81PHR75QKNE2Y799REXZG"},
  {"rank": 14, "streamer": "azdus", "views": 121, "duration": 26, "game": "Just Chatting", "title": "tyty", "url": "https://kick.com/azdus/clips/clip_01KVE9SRJ8RV039309WTR859K4"},
  {"rank": 15, "streamer": "azdus", "views": 113, "duration": 16, "game": "IRL", "title": "dla ciebie widzu", "url": "https://kick.com/azdus/clips/clip_01KVG2K8BJD6X35VYZ525VEZJP"},
  {"rank": 16, "streamer": "acie", "views": 111, "duration": 26, "game": "Grand Theft Auto V (GTA)", "title": "Vee the shooter", "url": "https://kick.com/acie/clips/clip_01KVEEZ1FR0MX2ZA6CAX1ZVW3R"},
  {"rank": 17, "streamer": "aktor", "views": 111, "duration": 60, "game": "IRL", "title": "maseczka majonezowa", "url": "https://kick.com/aktor/clips/clip_01KVG9MRAN9ER1J7TXVVK3RKRC"},
  {"rank": 18, "streamer": "8bit_goldy", "views": 108, "duration": 57, "game": "Grand Theft Auto V (GTA)", "title": "dada hahaha", "url": "https://kick.com/8bit_goldy/clips/clip_01KVE21DFTJN087JMY2RCF4C9F"},
  {"rank": 19, "streamer": "apocalpser", "views": 107, "duration": 180, "game": "Just Chatting", "title": "Ragıp Kışkırtma", "url": "https://kick.com/apocalpser/clips/clip_01KVEN73FB2X0CTY1RNXJX01RZ"},
  {"rank": 20, "streamer": "acie", "views": 91, "duration": 30, "game": "Grand Theft Auto V (GTA)", "title": "Carmine intro music", "url": "https://kick.com/acie/clips/clip_01KVE48RMP5HAH36CMP0CHFSW5"},
  {"rank": 21, "streamer": "azdus", "views": 84, "duration": 15, "game": "IRL", "title": "gasiennica", "url": "https://kick.com/azdus/clips/clip_01KVGEHHC8778ECE81E1ZHEBFZ"},
  {"rank": 22, "streamer": "alexduvor", "views": 79, "duration": 30, "game": "Grand Theft Auto V (GTA)", "title": "song", "url": "https://kick.com/alexduvor/clips/clip_01KVE7K7N19AHKAXC06N5BE843"},
  {"rank": 23, "streamer": "acie", "views": 77, "duration": 19, "game": "Grand Theft Auto V (GTA)", "title": "WICKED", "url": "https://kick.com/acie/clips/clip_01KVE9KJ2JSCXJTAN5T1MJQ6EY"},
  {"rank": 24, "streamer": "ambarlumm", "views": 68, "duration": 60, "game": "Pools, Hot Tubs & Bikinis", "title": "sexy dance", "url": "https://kick.com/ambarlumm/clips/clip_01KVGA4W7MEC71QX4SF80QYW7B"},
  {"rank": 25, "streamer": "antonicratv", "views": 66, "duration": 30, "game": "IRL", "title": "MAS FRIO ESE CRAFT", "url": "https://kick.com/antonicratv/clips/clip_01KVE16GE2HJX8WYTN6K4P939S"},
  {"rank": 26, "streamer": "azdus", "views": 66, "duration": 63, "game": "IRL", "title": "Werka mistrz kierownicy xDDDDD", "url": "https://kick.com/azdus/clips/clip_01KVG7TX7HCHVXY2ANT88YGYG5"},
  {"rank": 27, "streamer": "apocalpser", "views": 61, "duration": 101, "game": "Just Chatting", "title": "uzay abi rage", "url": "https://kick.com/apocalpser/clips/clip_01KVG2DRZCY08FBKYBQ46PT4KJ"},
  {"rank": 28, "streamer": "alfonsine", "views": 57, "duration": 44, "game": "Grand Theft Auto V (GTA)", "title": "Uristen very big xdd", "url": "https://kick.com/alfonsine/clips/clip_01KVFHVJBVABAMEA2A3E5ABE64"},
  {"rank": 29, "streamer": "alohasteve", "views": 57, "duration": 30, "game": "IRL", "title": "線路", "url": "https://kick.com/alohasteve/clips/clip_01KVGBSW0GX33TA33CHKDDRQFH"},
  {"rank": 30, "streamer": "astatoro", "views": 55, "duration": 30, "game": "Minecraft", "title": "fortress", "url": "https://kick.com/astatoro/clips/clip_01KVGCH1R9TJ1Q8122R8MCTT7G"},
  {"rank": 31, "streamer": "2sekundovymato", "views": 48, "duration": 60, "game": "Red Dead Redemption II", "title": "2Sekudnovybrechač", "url": "https://kick.com/2sekundovymato/clips/clip_01KVE2FHA566Y360WZ48JPEWKN"},
  {"rank": 32, "streamer": "apocalpser", "views": 47, "duration": 19, "game": "Just Chatting", "title": ".", "url": "https://kick.com/apocalpser/clips/clip_01KVE3BQHXVDKMYYKX0WJYNSDK"},
  {"rank": 33, "streamer": "bundachiara", "views": 47, "duration": 60, "game": "Just Chatting", "title": "jjj", "url": "https://kick.com/bundachiara/clips/clip_01KVFWAZS712VG1C4N5154FKPF"},
  {"rank": 34, "streamer": "ahmetturku", "views": 44, "duration": 60, "game": "Just Chatting", "title": "makarayız dimi abi !itemavm !case | Clip", "url": "https://kick.com/ahmetturku/clips/clip_01KVE08RPX9669DSZ16S3B8C9D"},
  {"rank": 35, "streamer": "bundachiara", "views": 44, "duration": 30, "game": "IRL", "title": "vaipat", "url": "https://kick.com/bundachiara/clips/clip_01KVG814N62VS2XKGM51P0EEA1"},
  {"rank": 36, "streamer": "alexis", "views": 41, "duration": 30, "game": "Slots & Casino", "title": "sd", "url": "https://kick.com/alexis/clips/clip_01KVETJ8HVSHVC3V6QJPZ9VWP9"},
  {"rank": 37, "streamer": "abodby", "views": 40, "duration": 30, "game": "Garena Free Fire", "title": "المفرق", "url": "https://kick.com/abodby/clips/clip_01KVFAK7SR8SF6WETZ2DN8FNXR"},
  {"rank": 38, "streamer": "ambarlumm", "views": 38, "duration": 60, "game": "Pools, Hot Tubs & Bikinis", "title": "dance", "url": "https://kick.com/ambarlumm/clips/clip_01KVGAD8SK75WJ2PQ5JVB9E25T"},
  {"rank": 39, "streamer": "bundachiara", "views": 38, "duration": 152, "game": "IRL", "title": "f", "url": "https://kick.com/bundachiara/clips/clip_01KVG80790MW3ZXF8149HRC2J1"},
  {"rank": 40, "streamer": "2sekundovymato", "views": 37, "duration": 48, "game": "Red Dead Redemption II", "title": "Maťo baf", "url": "https://kick.com/2sekundovymato/clips/clip_01KVE22J7E03H8W23B5FF8XWJE"},
  {"rank": 41, "streamer": "apocalpser", "views": 37, "duration": 94, "game": "Just Chatting", "title": "SS VS RAGIPLAR", "url": "https://kick.com/apocalpser/clips/clip_01KVEMZ7QWC56AP62RSN6VTWVJ"},
  {"rank": 42, "streamer": "bundachiara", "views": 37, "duration": 60, "game": "IRL", "title": "somekissalla painava vaippa ja chichi on norsu", "url": "https://kick.com/bundachiara/clips/clip_01KVG7YBC8TV23DSE37JM6VP8Z"},
  {"rank": 43, "streamer": "antonicratv", "views": 36, "duration": 180, "game": "IRL", "title": "Gh", "url": "https://kick.com/antonicratv/clips/clip_01KVE1GRZNGWTH8ZHY29RWQZ8N"},
  {"rank": 44, "streamer": "ayellol", "views": 33, "duration": 13, "game": "League of Legends", "title": "TROVOADAS DE CHOQUES K", "url": "https://kick.com/ayellol/clips/clip_01KVEH0E3SNWJ1NCKXGA6FN7B1"},
  {"rank": 45, "streamer": "bnltv", "views": 33, "duration": 30, "game": "Garena Free Fire", "title": "!s", "url": "https://kick.com/bnltv/clips/clip_01KVEEDA9NXAVD355FGH3BH44B"},
  {"rank": 46, "streamer": "bundachiara", "views": 31, "duration": 30, "game": "IRL", "title": "chi", "url": "https://kick.com/bundachiara/clips/clip_01KVG7NWZS0PWMHY2C67G3QYCZ"},
  {"rank": 47, "streamer": "acie", "views": 30, "duration": 60, "game": "Grand Theft Auto V (GTA)", "title": "love", "url": "https://kick.com/acie/clips/clip_01KVGDEA54G4W8JZJ5AK2AB2YW"},
  {"rank": 48, "streamer": "atro", "views": 29, "duration": 30, "game": "PUBG Mobile", "title": "ال", "url": "https://kick.com/atro/clips/clip_01KVG3QDAS2SMX050QNAVPR51J"},
  {"rank": 49, "streamer": "blackattack", "views": 29, "duration": 30, "game": "Grand Theft Auto V (GTA)", "title": "TEKOŞ CK", "url": "https://kick.com/blackattack/clips/clip_01KVDXQ4PQRCY37SMTS80EBTT1"},
  {"rank": 50, "streamer": "baianons", "views": 28, "duration": 10, "game": "Grand Theft Auto V (GTA)", "title": "gay", "url": "https://kick.com/baianons/clips/clip_01KVEMSJ774G12TSPGCG35GBJR"},
];
const KICK_TOP_CHANNELS = [
  {"rank": 1, "streamer": "azdus", "login": "azdus", "views": 1347, "clipCount": 30, "title": "Wyznanie miłości", "url": "https://kick.com/azdus/clips/clip_01KVF56AVR5KXDFZBYETYX766F"},
  {"rank": 2, "streamer": "aktor", "login": "aktor", "views": 1155, "clipCount": 30, "title": "RIZZ NA AZJATCE +20 PUNKTÓW", "url": "https://kick.com/aktor/clips/clip_01KVG7XHCF05YD1CK126P9SFVW"},
  {"rank": 3, "streamer": "8bit_goldy", "login": "8bit_goldy", "views": 724, "clipCount": 11, "title": "W dada <3", "url": "https://kick.com/8bit_goldy/clips/clip_01KVFCDFM5ECMG1G90XX1FZ256"},
  {"rank": 4, "streamer": "8bit_rusherwow", "login": "8bit_rusherwow", "views": 301, "clipCount": 1, "title": "Efforts to hain 😀", "url": "https://kick.com/8bit_rusherwow/clips/clip_01KVFEXMXKYXGCFW20GGV8Y63F"},
  {"rank": 5, "streamer": "buerolol", "login": "buerolol", "views": 210, "clipCount": 3, "title": "kkkk lavagem de dinheiro ?", "url": "https://kick.com/buerolol/clips/clip_01KVEGTNCDM4MDX06Y0PZ3M1DS"},
  {"rank": 6, "streamer": "8bitheadflicker", "login": "8bitheadflicker", "views": 185, "clipCount": 4, "title": "Turtle", "url": "https://kick.com/8bitheadflicker/clips/clip_01KVFJWYE9VM6CWVRGJC2TB1S0"},
  {"rank": 7, "streamer": "bundachiara", "login": "bundachiara", "views": 129, "clipCount": 17, "title": "smheininki", "url": "https://kick.com/bundachiara/clips/clip_01KVG81PHR75QKNE2Y799REXZG"},
  {"rank": 8, "streamer": "acie", "login": "acie", "views": 111, "clipCount": 5, "title": "Vee the shooter", "url": "https://kick.com/acie/clips/clip_01KVEEZ1FR0MX2ZA6CAX1ZVW3R"},
  {"rank": 9, "streamer": "apocalpser", "login": "apocalpser", "views": 107, "clipCount": 11, "title": "Ragıp Kışkırtma", "url": "https://kick.com/apocalpser/clips/clip_01KVEN73FB2X0CTY1RNXJX01RZ"},
  {"rank": 10, "streamer": "alexduvor", "login": "alexduvor", "views": 79, "clipCount": 6, "title": "song", "url": "https://kick.com/alexduvor/clips/clip_01KVE7K7N19AHKAXC06N5BE843"},
  {"rank": 11, "streamer": "ambarlumm", "login": "ambarlumm", "views": 68, "clipCount": 3, "title": "sexy dance", "url": "https://kick.com/ambarlumm/clips/clip_01KVGA4W7MEC71QX4SF80QYW7B"},
  {"rank": 12, "streamer": "antonicratv", "login": "antonicratv", "views": 66, "clipCount": 27, "title": "MAS FRIO ESE CRAFT", "url": "https://kick.com/antonicratv/clips/clip_01KVE16GE2HJX8WYTN6K4P939S"},
  {"rank": 13, "streamer": "alfonsine", "login": "alfonsine", "views": 57, "clipCount": 2, "title": "Uristen very big xdd", "url": "https://kick.com/alfonsine/clips/clip_01KVFHVJBVABAMEA2A3E5ABE64"},
  {"rank": 14, "streamer": "alohasteve", "login": "alohasteve", "views": 57, "clipCount": 2, "title": "線路", "url": "https://kick.com/alohasteve/clips/clip_01KVGBSW0GX33TA33CHKDDRQFH"},
  {"rank": 15, "streamer": "astatoro", "login": "astatoro", "views": 55, "clipCount": 9, "title": "fortress", "url": "https://kick.com/astatoro/clips/clip_01KVGCH1R9TJ1Q8122R8MCTT7G"},
  {"rank": 16, "streamer": "2sekundovymato", "login": "2sekundovymato", "views": 48, "clipCount": 20, "title": "2Sekudnovybrechač", "url": "https://kick.com/2sekundovymato/clips/clip_01KVE2FHA566Y360WZ48JPEWKN"},
  {"rank": 17, "streamer": "ahmetturku", "login": "ahmetturku", "views": 44, "clipCount": 8, "title": "makarayız dimi abi !itemavm !case | Clip", "url": "https://kick.com/ahmetturku/clips/clip_01KVE08RPX9669DSZ16S3B8C9D"},
  {"rank": 18, "streamer": "alexis", "login": "alexis", "views": 41, "clipCount": 6, "title": "sd", "url": "https://kick.com/alexis/clips/clip_01KVETJ8HVSHVC3V6QJPZ9VWP9"},
  {"rank": 19, "streamer": "abodby", "login": "abodby", "views": 40, "clipCount": 26, "title": "المفرق", "url": "https://kick.com/abodby/clips/clip_01KVFAK7SR8SF6WETZ2DN8FNXR"},
  {"rank": 20, "streamer": "ayellol", "login": "ayellol", "views": 33, "clipCount": 8, "title": "TROVOADAS DE CHOQUES K", "url": "https://kick.com/ayellol/clips/clip_01KVEH0E3SNWJ1NCKXGA6FN7B1"},
  {"rank": 21, "streamer": "bnltv", "login": "bnltv", "views": 33, "clipCount": 19, "title": "!s", "url": "https://kick.com/bnltv/clips/clip_01KVEEDA9NXAVD355FGH3BH44B"},
  {"rank": 22, "streamer": "atro", "login": "atro", "views": 29, "clipCount": 8, "title": "ال", "url": "https://kick.com/atro/clips/clip_01KVG3QDAS2SMX050QNAVPR51J"},
  {"rank": 23, "streamer": "blackattack", "login": "blackattack", "views": 29, "clipCount": 3, "title": "TEKOŞ CK", "url": "https://kick.com/blackattack/clips/clip_01KVDXQ4PQRCY37SMTS80EBTT1"},
  {"rank": 24, "streamer": "baianons", "login": "baianons", "views": 28, "clipCount": 11, "title": "gay", "url": "https://kick.com/baianons/clips/clip_01KVEMSJ774G12TSPGCG35GBJR"},
  {"rank": 25, "streamer": "anthonyz", "login": "anthonyz", "views": 27, "clipCount": 2, "title": "FEMILY", "url": "https://kick.com/anthonyz/clips/clip_01KVF0FMJ6EP5BNW6SC443A238"},
  {"rank": 26, "streamer": "blush", "login": "blush", "views": 26, "clipCount": 15, "title": "kegriye atarız", "url": "https://kick.com/blush/clips/clip_01KVE537MXD1TN2HTC1RTPHP2Z"},
  {"rank": 27, "streamer": "busqweit", "login": "busqweit", "views": 26, "clipCount": 18, "title": "berkcan ck", "url": "https://kick.com/busqweit/clips/clip_01KVES257V9AN6FXS59XFZ34W9"},
  {"rank": 28, "streamer": "annoying", "login": "annoying", "views": 22, "clipCount": 2, "title": "on swish??", "url": "https://kick.com/annoying/clips/clip_01KVE2ASHSATNCW5XJQ8E33P50"},
  {"rank": 29, "streamer": "ada123w", "login": "ada123w", "views": 21, "clipCount": 2, "title": "merhabalar", "url": "https://kick.com/ada123w/clips/clip_01KVE3KVQ1DRYVSGSBSEKHJGXG"},
  {"rank": 30, "streamer": "aruberutomakoto", "login": "aruberutomakoto", "views": 20, "clipCount": 3, "title": "maid pisa a aru", "url": "https://kick.com/aruberutomakoto/clips/clip_01KVENAGJ9A8GSKKQMY6TG986N"},
  {"rank": 31, "streamer": "benjaz", "login": "benjaz", "views": 20, "clipCount": 30, "title": "CHALA-PLAY", "url": "https://kick.com/benjaz/clips/clip_01KVEJW1GK5KC64HFMZQZ50DEX"},
  {"rank": 32, "streamer": "01vez1r", "login": "01vez1r", "views": 19, "clipCount": 1, "title": "SAGENLUV VEZİRİ DOMALTIYOR", "url": "https://kick.com/01vez1r/clips/clip_01KVG5PBMCFF5X5C6Z646RSSFE"},
  {"rank": 33, "streamer": "bladeito", "login": "bladeito", "views": 19, "clipCount": 11, "title": "útěk století", "url": "https://kick.com/bladeito/clips/clip_01KVFV90RR3WECK55NS9MW2J73"},
  {"rank": 34, "streamer": "audaz", "login": "audaz", "views": 16, "clipCount": 2, "title": "ARMANDO MEU", "url": "https://kick.com/audaz/clips/clip_01KVEKHX0Y6QWK453PZFJ9RSJT"},
  {"rank": 35, "streamer": "berryyboo", "login": "berryyboo", "views": 15, "clipCount": 1, "title": "OOP", "url": "https://kick.com/berryyboo/clips/clip_01KVESKR234HYNZ3E2WVMCDXFY"},
  {"rank": 36, "streamer": "brunenger", "login": "brunenger", "views": 15, "clipCount": 10, "title": "ttt", "url": "https://kick.com/brunenger/clips/clip_01KVEVQXBYV78HVSY9JWP8XK0H"},
  {"rank": 37, "streamer": "aksilsif", "login": "aksilsif", "views": 14, "clipCount": 7, "title": "Aksilsif", "url": "https://kick.com/aksilsif/clips/clip_01KVEJ5JJN0A29V4WT9FQWBD8F"},
  {"rank": 38, "streamer": "brajenirl", "login": "brajenirl", "views": 13, "clipCount": 2, "title": "rreh", "url": "https://kick.com/brajenirl/clips/clip_01KVG83P8N82TPAACSTBTXP2FQ"},
  {"rank": 39, "streamer": "apriljr", "login": "apriljr", "views": 11, "clipCount": 3, "title": "Grsl ta**ak machine", "url": "https://kick.com/apriljr/clips/clip_01KVE0SJHBMWMS549PQXHKXKFF"},
  {"rank": 40, "streamer": "anna_monik", "login": "anna_monik", "views": 10, "clipCount": 1, "title": "o;", "url": "https://kick.com/anna_monik/clips/clip_01KVGETQPEFJG29NA191RAMGHW"},
  {"rank": 41, "streamer": "berkobir", "login": "berkobir", "views": 10, "clipCount": 1, "title": "%600 akçay sex", "url": "https://kick.com/berkobir/clips/clip_01KVE4A62B3KGEE4M7TNM1KDFP"},
  {"rank": 42, "streamer": "cacapa10", "login": "cacapa10", "views": 10, "clipCount": 1, "title": "letam kör", "url": "https://kick.com/cacapa10/clips/clip_01KVE76DA0X5GT1V3JN0HK9CYX"},
  {"rank": 43, "streamer": "adrienbroner", "login": "adrienbroner", "views": 9, "clipCount": 30, "title": "Coochie Just Out Over There On The Couch", "url": "https://kick.com/adrienbroner/clips/clip_01KVG8P6HR4DEVQJD0XZV7QVA3"},
  {"rank": 44, "streamer": "bennyrewards", "login": "bennyrewards", "views": 9, "clipCount": 2, "title": "Massive Orange Connect on CANDY RUSH - $3.5k+", "url": "https://kick.com/bennyrewards/clips/clip_01KVDZ0YAXKADEEJ1KPWW4Z1WK"},
  {"rank": 45, "streamer": "besi523", "login": "besi523", "views": 9, "clipCount": 1, "title": "Padniesz, powstań", "url": "https://kick.com/besi523/clips/clip_01KVGCRFZYEJ5ED35JW4SHGPMT"},
  {"rank": 46, "streamer": "americaesportsdota2", "login": "americaesportsdota2", "views": 8, "clipCount": 18, "title": "xd", "url": "https://kick.com/americaesportsdota2/clips/clip_01KVET80AEASBA84EQVPFYZWPG"},
  {"rank": 47, "streamer": "bigezmoge", "login": "bigezmoge", "views": 8, "clipCount": 8, "title": "man sam saberi nistam", "url": "https://kick.com/bigezmoge/clips/clip_01KVEEKESZA47ETT4SS410SXDG"},
  {"rank": 48, "streamer": "animalitoo", "login": "animalitoo", "views": 7, "clipCount": 12, "title": "TIRENSE LA SOÑADORA DE HOY!wsp !s | Clip", "url": "https://kick.com/animalitoo/clips/clip_01KVE4ZNVA9CQZSWDCTV6TWQN3"},
  {"rank": 49, "streamer": "ahapulco", "login": "ahapulco", "views": 6, "clipCount": 8, "title": "oho", "url": "https://kick.com/ahapulco/clips/clip_01KVG5WKEHE6BTEYZKAR413GSV"},
  {"rank": 50, "streamer": "amir_vht", "login": "amir_vht", "views": 6, "clipCount": 1, "title": "mashin dozdidan", "url": "https://kick.com/amir_vht/clips/clip_01KVEG14GNQBQET4B1BSY4YJ12"},
  {"rank": 51, "streamer": "androgenic", "login": "androgenic", "views": 6, "clipCount": 30, "title": "hair", "url": "https://kick.com/androgenic/clips/clip_01KVG7466NRT7NDDEWH66JW4V7"},
  {"rank": 52, "streamer": "bishopirl", "login": "bishopirl", "views": 6, "clipCount": 4, "title": "karı+para bir de öldürdük xdd", "url": "https://kick.com/bishopirl/clips/clip_01KVEE2G7MMCV57NX5A755D5QT"},
  {"rank": 53, "streamer": "bulwark7", "login": "bulwark7", "views": 6, "clipCount": 5, "title": "kenomaster7 63x", "url": "https://kick.com/bulwark7/clips/clip_01KVEAFHTF6TKP6XX75190RASW"},
  {"rank": 54, "streamer": "6kodak9", "login": "6kodak9", "views": 5, "clipCount": 30, "title": "ХВАЗДАХЗДДХЗВДХЗАДАЗХВ", "url": "https://kick.com/6kodak9/clips/clip_01KVEG3CGPRGBSTHYB9B6CESNS"},
  {"rank": 55, "streamer": "abuswe7l", "login": "abuswe7l", "views": 5, "clipCount": 23, "title": ".", "url": "https://kick.com/abuswe7l/clips/clip_01KVFRCP4E3833S6QF4NRAA89B"},
  {"rank": 56, "streamer": "brucer", "login": "brucer", "views": 5, "clipCount": 5, "title": "brucer solando", "url": "https://kick.com/brucer/clips/clip_01KVESQQK3JG5F0ANTTXYFWGYX"},
  {"rank": 57, "streamer": "2dejv", "login": "2dejv", "views": 4, "clipCount": 2, "title": "najebany ace", "url": "https://kick.com/2dejv/clips/clip_01KVFAYG51B59R47BQDNH9NNVV"},
  {"rank": 58, "streamer": "abokhamiss", "login": "abokhamiss", "views": 4, "clipCount": 1, "title": "إحتفالية ال 500 متابع نععااممممممم", "url": "https://kick.com/abokhamiss/clips/clip_01KVEP6YA6VGG40V4BNY682WVY"},
  {"rank": 59, "streamer": "animekizlariniseviorum", "login": "animekizlariniseviorum", "views": 4, "clipCount": 1, "title": "DUHAN ABİ PASTA VERİYORLAR ARKADA", "url": "https://kick.com/animekizlariniseviorum/clips/clip_01KVG3QKY62KKWT3P2D18S2BJR"},
  {"rank": 60, "streamer": "antaurus", "login": "antaurus", "views": 4, "clipCount": 1, "title": "agradece", "url": "https://kick.com/antaurus/clips/clip_01KVE3RH9F3KAAEGBGJ03WASXC"},
  {"rank": 61, "streamer": "1mperius", "login": "1mperius", "views": 3, "clipCount": 3, "title": "CHATLE MECCHA CHAMELEON !itemsati | Clip", "url": "https://kick.com/1mperius/clips/clip_01KVEFTD82Y9ENDED0Z4ZDJV1T"},
  {"rank": 62, "streamer": "3adooli", "login": "3adooli", "views": 3, "clipCount": 1, "title": "Greeting with sandal", "url": "https://kick.com/3adooli/clips/clip_01KVFVFBFZP7Y0CZR02N6E7NTB"},
  {"rank": 63, "streamer": "aladinottv", "login": "aladinottv", "views": 3, "clipCount": 3, "title": "ci riusciresti gabbrone?", "url": "https://kick.com/aladinottv/clips/clip_01KVGETB5985PZYZ7B32V2KQ81"},
  {"rank": 64, "streamer": "angelaoreo", "login": "angelaoreo", "views": 3, "clipCount": 1, "title": "üü", "url": "https://kick.com/angelaoreo/clips/clip_01KVEFG78RMN9RFXAEMH1D4F4J"},
  {"rank": 65, "streamer": "arteezy", "login": "arteezy", "views": 3, "clipCount": 1, "title": "wat", "url": "https://kick.com/arteezy/clips/clip_01KVE16SS4VZBKJ4XS0X43WPM8"},
  {"rank": 66, "streamer": "badgenius0", "login": "badgenius0", "views": 3, "clipCount": 2, "title": "im outttttt XD", "url": "https://kick.com/badgenius0/clips/clip_01KVEBEB2505Q4R8FBDK8WCG1Z"},
  {"rank": 67, "streamer": "blackbradpittog", "login": "blackbradpittog", "views": 3, "clipCount": 4, "title": "LIMBO", "url": "https://kick.com/blackbradpittog/clips/clip_01KVFW3ZAH9W16REXMXMXYRTD7"},
  {"rank": 68, "streamer": "bozki", "login": "bozki", "views": 3, "clipCount": 1, "title": ".", "url": "https://kick.com/bozki/clips/clip_01KVE8WZCF02RVVXQCAFWX08AF"},
  {"rank": 69, "streamer": "buladas", "login": "buladas", "views": 3, "clipCount": 13, "title": "Gangsanc", "url": "https://kick.com/buladas/clips/clip_01KVFKWS207SWR3Q88AE9M2M8S"},
  {"rank": 70, "streamer": "2bo5li", "login": "2bo5li", "views": 2, "clipCount": 9, "title": "ZZZ", "url": "https://kick.com/2bo5li/clips/clip_01KVFYP9FYCZX66EHXTXC7EBTQ"},
  {"rank": 71, "streamer": "aimstylee", "login": "aimstylee", "views": 2, "clipCount": 2, "title": "İZLEDİKÇE KAZAN - Aile çay bahçes | Clip", "url": "https://kick.com/aimstylee/clips/clip_01KVE8CS08YFEB7D3JDQPT1SS1"},
  {"rank": 72, "streamer": "alynnushgambles", "login": "alynnushgambles", "views": 2, "clipCount": 3, "title": "wwww win rave", "url": "https://kick.com/alynnushgambles/clips/clip_01KVE1M4JPYYPNN5D26ZADZYV9"},
  {"rank": 73, "streamer": "amirphanthom", "login": "amirphanthom", "views": 2, "clipCount": 7, "title": "DotKA Time Pudgini !instagram !yo | Clip", "url": "https://kick.com/amirphanthom/clips/clip_01KVG05HQM0RMF92XQE85NK3EN"},
  {"rank": 74, "streamer": "atakanbaha", "login": "atakanbaha", "views": 2, "clipCount": 8, "title": "wt", "url": "https://kick.com/atakanbaha/clips/clip_01KVEGV048XB8RZN2E3G53KSMR"},
  {"rank": 75, "streamer": "bariscavdar", "login": "bariscavdar", "views": 2, "clipCount": 12, "title": "valo ımmo 1 rank duo !dc !bynogam | Clip", "url": "https://kick.com/bariscavdar/clips/clip_01KVE726AS36C3PNJ2YA3H2ZJ7"},
  {"rank": 76, "streamer": "blondiee", "login": "blondiee", "views": 2, "clipCount": 1, "title": "slamming", "url": "https://kick.com/blondiee/clips/clip_01KVEA4FWWMHZHFR7XPW0A6H0Q"},
  {"rank": 77, "streamer": "boudzou", "login": "boudzou", "views": 2, "clipCount": 2, "title": "quadra sena", "url": "https://kick.com/boudzou/clips/clip_01KVE88RME16FQF3PEDXZ947W7"},
  {"rank": 78, "streamer": "bozo96", "login": "bozo96", "views": 2, "clipCount": 2, "title": "Jj", "url": "https://kick.com/bozo96/clips/clip_01KVE412AG8A8EJWK474K6A3QH"},
  {"rank": 79, "streamer": "burce", "login": "burce", "views": 2, "clipCount": 4, "title": "FENA GRIP GAMING | Clip", "url": "https://kick.com/burce/clips/clip_01KVG4DZ35AS2P4XFNYX9TCQT6"},
  {"rank": 80, "streamer": "bvkos", "login": "bvkos", "views": 2, "clipCount": 1, "title": "OG", "url": "https://kick.com/bvkos/clips/clip_01KVGAGQ7SQ191HKB7M5R37HTD"},
  {"rank": 81, "streamer": "00april", "login": "00april", "views": 1, "clipCount": 2, "title": "brothers", "url": "https://kick.com/00april/clips/clip_01KVGASZNZJ6SDC2ST9SNW80GC"},
  {"rank": 82, "streamer": "3ktv_pl", "login": "3ktv_pl", "views": 1, "clipCount": 1, "title": "Ciacho dla Pati", "url": "https://kick.com/3ktv_pl/clips/clip_01KVGAP2HW503VBV4HZQ5GZF44"},
  {"rank": 83, "streamer": "abdellahchafai", "login": "abdellahchafai", "views": 1, "clipCount": 6, "title": "ان", "url": "https://kick.com/abdellahchafai/clips/clip_01KVEDB46RPA79XXF75M5X824S"},
  {"rank": 84, "streamer": "abonyf", "login": "abonyf", "views": 1, "clipCount": 1, "title": ".", "url": "https://kick.com/abonyf/clips/clip_01KVFEX31BD5JN4F8AX5MFB0BY"},
  {"rank": 85, "streamer": "absi", "login": "absi", "views": 1, "clipCount": 30, "title": "123123", "url": "https://kick.com/absi/clips/clip_01KVGE0SV2SK5FMSB36TEH9K39"},
  {"rank": 86, "streamer": "accamary", "login": "accamary", "views": 1, "clipCount": 1, "title": "xddd", "url": "https://kick.com/accamary/clips/clip_01KVG8DKAJXQV58W19WAPJD7SB"},
  {"rank": 87, "streamer": "adolfz", "login": "adolfz", "views": 1, "clipCount": 1, "title": "eu", "url": "https://kick.com/adolfz/clips/clip_01KVGE0099W9QJJWJBYYW8Y82N"},
  {"rank": 88, "streamer": "akreppss", "login": "akreppss", "views": 1, "clipCount": 1, "title": "ace clutch Tears diyorum sana", "url": "https://kick.com/akreppss/clips/clip_01KVG3R7JSFG13CR5FKMGW6FXV"},
  {"rank": 89, "streamer": "anarhistabg", "login": "anarhistabg", "views": 1, "clipCount": 1, "title": "СХЕМАДЖИЯ на ПАЗАРА!kolelo !sub ! | Clip", "url": "https://kick.com/anarhistabg/clips/clip_01KVE6XH3WMNCQH3NY3GFVAAXX"},
  {"rank": 90, "streamer": "asmongold247", "login": "asmongold247", "views": 1, "clipCount": 1, "title": "KEKW", "url": "https://kick.com/asmongold247/clips/clip_01KVG6XXSD7Q0W3HF4E9M6W2YY"},
  {"rank": 91, "streamer": "aspentv", "login": "aspentv", "views": 1, "clipCount": 1, "title": "chyba zawieszenie wyjebalo", "url": "https://kick.com/aspentv/clips/clip_01KVGBBP9FVH87J8J8C4HRACH7"},
  {"rank": 92, "streamer": "ayszrn", "login": "ayszrn", "views": 1, "clipCount": 2, "title": "yazı okumasını bilmiyom | Clip", "url": "https://kick.com/ayszrn/clips/clip_01KVE8GG1RWNDPZ49WPRZ6DTRB"},
  {"rank": 93, "streamer": "babaschmurda", "login": "babaschmurda", "views": 1, "clipCount": 3, "title": "john wortel ghosted 4 days", "url": "https://kick.com/babaschmurda/clips/clip_01KVGEVDC03JZ3HVAAPT05GDPG"},
  {"rank": 94, "streamer": "baianotv", "login": "baianotv", "views": 1, "clipCount": 4, "title": "i", "url": "https://kick.com/baianotv/clips/clip_01KVENME8MSF0KHJ39Z6PW3P4E"},
  {"rank": 95, "streamer": "bebardoo", "login": "bebardoo", "views": 1, "clipCount": 1, "title": ".", "url": "https://kick.com/bebardoo/clips/clip_01KVG4K8E7AG05Y0YAV45WPMVW"},
  {"rank": 96, "streamer": "beckett22", "login": "beckett22", "views": 1, "clipCount": 1, "title": "lmaoooo", "url": "https://kick.com/beckett22/clips/clip_01KVEHPSZPECZW3XPE29F1537Y"},
  {"rank": 97, "streamer": "berkel", "login": "berkel", "views": 1, "clipCount": 5, "title": "slip and fall on boat ramp", "url": "https://kick.com/berkel/clips/clip_01KVEMR2X41YKF0B8KFM0JBTH1"},
  {"rank": 98, "streamer": "betboombrasil", "login": "betboombrasil", "views": 1, "clipCount": 5, "title": "yuurih", "url": "https://kick.com/betboombrasil/clips/clip_01KVDXEXQ0SQKSNJPV9EXVGPHF"},
  {"rank": 99, "streamer": "bigbat", "login": "bigbat", "views": 1, "clipCount": 2, "title": "SİLAH CARTELİ RAMAZAN KNGL RP !dc | Clip", "url": "https://kick.com/bigbat/clips/clip_01KVGD3PMMMX5P27SJH3QH677C"},
  {"rank": 100, "streamer": "brain", "login": "brain", "views": 1, "clipCount": 1, "title": "..", "url": "https://kick.com/brain/clips/clip_01KVFQ0AHHM1WGA1B5N14NWTVF"},
];

const TWITCH_GAME_VOLUME = [{"rank": 1, "game": "Resident Evil 4", "clips": 109}, {"rank": 2, "game": "Just Chatting", "clips": 100}, {"rank": 3, "game": "Deadlock", "clips": 100}, {"rank": 4, "game": "Call of Duty: Black Ops 7", "clips": 100}, {"rank": 5, "game": "DayZ", "clips": 100}, {"rank": 6, "game": "FINAL FANTASY XIV ONLINE", "clips": 100}, {"rank": 7, "game": "Overwatch", "clips": 100}, {"rank": 8, "game": "Call of Duty: Warzone", "clips": 100}, {"rank": 9, "game": "Rocket League", "clips": 100}, {"rank": 10, "game": "ARC Raiders", "clips": 100}, {"rank": 11, "game": "Red Dead Redemption II", "clips": 100}, {"rank": 12, "game": "Apex Legends", "clips": 100}, {"rank": 13, "game": "Dark and Darker", "clips": 100}, {"rank": 14, "game": "EA Sports FC 26", "clips": 100}, {"rank": 15, "game": "Fall Guys", "clips": 100}, {"rank": 16, "game": "ASMR", "clips": 100}, {"rank": 17, "game": "Brawl Stars", "clips": 100}, {"rank": 18, "game": "Rainbow Six Siege", "clips": 100}, {"rank": 19, "game": "PUBG: BATTLEGROUNDS", "clips": 100}, {"rank": 20, "game": "MLB The Show 26", "clips": 100}, {"rank": 21, "game": "Delta Force", "clips": 100}, {"rank": 22, "game": "Warframe", "clips": 100}, {"rank": 23, "game": "Hunt: Showdown 1896", "clips": 100}, {"rank": 24, "game": "The Legend of Zelda: Ocarina of Time", "clips": 100}, {"rank": 25, "game": "NTE: Neverness to Everness", "clips": 100}];

type ClipRow = { rank: number; streamer: string; views: number; duration?: number; game?: string; title: string; url: string; };
type ChannelRow = { rank: number; streamer: string; login: string; views: number; clipCount: number; title: string; url: string; };

function fmtViews(n: number) { return n.toLocaleString('en-US'); }
function truncate(s: string, max = 48) { return s.length <= max ? s : s.slice(0, max - 1) + '…'; }

function clipTableRows(clips: ClipRow[], prefix: string) {
  return clips.map((r) => ({
    key: `${prefix}-${r.rank}`,
    tone: r.rank <= 3 ? ('success' as const) : undefined,
    cells: {
      rank: <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.rank}</Text>,
      streamer: <Text weight="medium">{r.streamer}</Text>,
      views: <Text weight="medium" style={{ fontFamily: 'monospace' }}>{fmtViews(r.views)}</Text>,
      dur: <Text tone="subtle" style={{ fontSize: 12 }}>{r.duration ?? '—'}</Text>,
      game: <Text tone="subtle" style={{ fontSize: 12 }}>{truncate(r.game || '—', 22)}</Text>,
      title: <Text style={{ fontSize: 13 }}>{truncate(r.title)}</Text>,
      link: r.url ? <Link href={r.url}>Open</Link> : <Text tone="subtle">—</Text>,
    },
  }));
}

function channelTableRows(channels: ChannelRow[], prefix: string) {
  return channels.map((r) => ({
    key: `${prefix}-${r.login}`,
    tone: r.rank <= 3 ? ('success' as const) : undefined,
    cells: {
      rank: <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.rank}</Text>,
      streamer: (
        <Stack gap={2}>
          <Text weight="medium">{r.streamer}</Text>
          <Text tone="subtle" style={{ fontSize: 11, fontFamily: 'monospace' }}>{r.login}</Text>
        </Stack>
      ),
      views: <Text weight="medium" style={{ fontFamily: 'monospace' }}>{fmtViews(r.views)}</Text>,
      clips: <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.clipCount}</Text>,
      title: <Text style={{ fontSize: 13 }}>{truncate(r.title, 42)}</Text>,
      link: r.url ? <Link href={r.url}>Open</Link> : <Text tone="subtle">—</Text>,
    },
  }));
}

export default function ClipLeaderboard24hPlatform() {
  return (
    <Stack gap={20}>
      <Stack gap={6}>
        <H1>Platform-wide clips — last 24h</H1>
        <Text tone="subtle">
          Clips only, ranked by views · Twitch Helix top {TWITCH_GAMES} games + Kick Apify discovery · {GENERATED_AT.replace('T',' ').slice(0,19)} UTC
        </Text>
      </Stack>

      <Callout tone="info">
        <Text weight="medium">Widest practical coverage</Text>
        <Text tone="subtle" style={{ marginTop: 4, fontSize: 13 }}>
          Twitch: top 500 live categories × 100 clips (Helix has no global feed). Kick: 2,371 channels discovered (top/live + 15 categories), clip scrape on each — 110 had clips in 24h. Use the game-volume table to drop categories that don&apos;t fit your audience.
        </Text>
      </Callout>

      <Grid columns={3} gap={12}>
        <Stat label="Twitch clips" value={fmtViews(TWITCH_CLIPS)} tone="info" />
        <Stat label="Twitch channels" value={fmtViews(TWITCH_CHANNEL_COUNT)} tone="info" />
        <Stat label="Twitch games scanned" value={String(TWITCH_GAMES)} tone="neutral" />
        <Stat label="Kick channels discovered" value={fmtViews(KICK_DISCOVERED)} tone="success" />
        <Stat label="Kick clips (24h)" value={fmtViews(KICK_CLIPS)} tone="success" />
        <Stat label="Kick channels w/ clips" value={String(KICK_CHANNEL_COUNT)} tone="success" />
      </Grid>

      <Row gap={8} align="center"><H2>Twitch</H2><Pill tone="info" size="sm">top 50 of {fmtViews(TWITCH_CLIPS)}</Pill></Row>
      <Table columns={[
        { key: 'rank', label: '#', width: 36 },
        { key: 'streamer', label: 'Streamer', width: 110 },
        { key: 'views', label: 'Views', width: 80, align: 'right' },
        { key: 'dur', label: 'Sec', width: 44, align: 'right' },
        { key: 'game', label: 'Game', width: 100 },
        { key: 'title', label: 'Clip title' },
        { key: 'link', label: 'URL', width: 64 },
      ]} rows={clipTableRows(TWITCH_TOP_CLIPS as ClipRow[], 'tw')} />

      <CollapsibleSection title="Twitch — clip volume by game category (narrow here)" defaultOpen={true}>
        <Stack gap={8} style={{ paddingTop: 8 }}>
          <Text tone="subtle" style={{ fontSize: 13 }}>Clip count per game in the 24h window — drop categories with high volume but wrong audience fit</Text>
          <Table columns={[
            { key: 'rank', label: '#', width: 36 },
            { key: 'game', label: 'Game / category' },
            { key: 'clips', label: 'Clips in 24h', width: 100, align: 'right' },
          ]} rows={TWITCH_GAME_VOLUME.map((r) => ({
            key: r.game,
            cells: {
              rank: <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.rank}</Text>,
              game: <Text style={{ fontSize: 13 }}>{r.game}</Text>,
              clips: <Text style={{ fontFamily: 'monospace' }}>{fmtViews(r.clips)}</Text>,
            },
          }))} />
        </Stack>
      </CollapsibleSection>

      <CollapsibleSection title={`Twitch — top clip per channel (top 50 of ${fmtViews(TWITCH_CHANNEL_COUNT)})`} defaultOpen={false}>
        <Stack gap={8} style={{ paddingTop: 8 }}>
          <Table columns={[
            { key: 'rank', label: '#', width: 36 },
            { key: 'streamer', label: 'Channel', width: 120 },
            { key: 'views', label: 'Top views', width: 80, align: 'right' },
            { key: 'clips', label: 'Clips', width: 56, align: 'right' },
            { key: 'title', label: 'Top clip' },
            { key: 'link', label: 'URL', width: 64 },
          ]} rows={channelTableRows(TWITCH_TOP_CHANNELS as ChannelRow[], 'twch')} />
        </Stack>
      </CollapsibleSection>

      <Divider />

      <Row gap={8} align="center"><H2>Kick</H2><Pill tone="success" size="sm">top 50 of {KICK_CLIPS}</Pill></Row>
      <Table columns={[
        { key: 'rank', label: '#', width: 36 },
        { key: 'streamer', label: 'Channel', width: 110 },
        { key: 'views', label: 'Views', width: 80, align: 'right' },
        { key: 'dur', label: 'Sec', width: 44, align: 'right' },
        { key: 'title', label: 'Clip title' },
        { key: 'link', label: 'URL', width: 64 },
      ]} rows={clipTableRows(KICK_TOP_CLIPS as ClipRow[], 'k')} />

      <CollapsibleSection title={`Kick — all ${KICK_CHANNEL_COUNT} channels with clips (by top clip views)`} defaultOpen={true}>
        <Stack gap={8} style={{ paddingTop: 8 }}>
          <Text tone="subtle" style={{ fontSize: 13 }}>{KICK_SCRAPE_ERRORS} discovered channels had no clips or scrape failed — normal for inactive channels</Text>
          <Table columns={[
            { key: 'rank', label: '#', width: 36 },
            { key: 'streamer', label: 'Channel', width: 120 },
            { key: 'views', label: 'Top views', width: 80, align: 'right' },
            { key: 'clips', label: 'Clips', width: 56, align: 'right' },
            { key: 'title', label: 'Top clip' },
            { key: 'link', label: 'URL', width: 64 },
          ]} rows={channelTableRows(KICK_TOP_CHANNELS as ChannelRow[], 'kch')} />
        </Stack>
      </CollapsibleSection>

      <Callout tone="info">
        <Text weight="medium">No Kick follow list required</Text>
        <Text tone="subtle" style={{ marginTop: 4, fontSize: 13 }}>
          Discovery uses public Kick rankings + live directory. Clips fetched by channel slug. Full JSON: logs/clip_leaderboard_24h_platform.json
        </Text>
      </Callout>

      <Spacer size={8} />
    </Stack>
  );
}
