/**
 * The emoji people can pick from.
 *
 * A curated list as code, for the same reason the task and cosmetic catalogues
 * are: it ships with a release, it is diffable, and it needs no table, no
 * migration and no third dependency carrying several thousand entries and a
 * megabyte of skin-tone permutations nobody in a small group will ever scroll
 * through.
 *
 * These are Unicode characters, not images. That is the whole reason standard
 * emoji need no upload pipeline - they are text, they travel in the message
 * body, they are searchable, and every platform draws them in its own house
 * style. Custom emoji are a genuinely different feature and will need the
 * attachment machinery.
 *
 * `keywords` exists because the Unicode name is often not what anyone would
 * type: "face with tears of joy" is the thing people search for as "laugh"
 * or "lol".
 */

export interface Emoji {
  char: string;
  /** The Unicode-ish name, shown on hover. */
  name: string;
  /** Extra search terms, space separated. Never repeats the name. */
  keywords?: string;
}

export interface EmojiGroup {
  name: string;
  /** Shown on the group's tab in the picker. */
  tab: string;
  emoji: Emoji[];
}

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    name: 'Smileys',
    tab: '😀',
    emoji: [
      { char: '😀', name: 'grinning', keywords: 'smile happy' },
      { char: '😃', name: 'smiley', keywords: 'happy joy' },
      { char: '😄', name: 'smile', keywords: 'happy joy laugh' },
      { char: '😁', name: 'grin', keywords: 'happy' },
      { char: '😆', name: 'laughing', keywords: 'lol haha' },
      { char: '😅', name: 'sweat smile', keywords: 'relief phew' },
      { char: '🤣', name: 'rolling on the floor laughing', keywords: 'rofl lol' },
      { char: '😂', name: 'tears of joy', keywords: 'lol laugh crying funny' },
      { char: '🙂', name: 'slight smile', keywords: 'fine ok' },
      { char: '🙃', name: 'upside down', keywords: 'sarcasm irony' },
      { char: '😉', name: 'wink', keywords: 'flirt' },
      { char: '😊', name: 'blush', keywords: 'happy shy' },
      { char: '😇', name: 'innocent', keywords: 'angel halo' },
      { char: '😍', name: 'heart eyes', keywords: 'love crush' },
      { char: '🤩', name: 'star struck', keywords: 'wow amazed' },
      { char: '😘', name: 'blowing a kiss', keywords: 'love' },
      { char: '😗', name: 'kissing' },
      { char: '😋', name: 'yum', keywords: 'tasty delicious tongue' },
      { char: '😛', name: 'tongue out', keywords: 'cheeky' },
      { char: '😜', name: 'winking tongue', keywords: 'silly cheeky' },
      { char: '🤪', name: 'zany', keywords: 'crazy silly wild' },
      { char: '🤨', name: 'raised eyebrow', keywords: 'suspicious doubt' },
      { char: '🧐', name: 'monocle', keywords: 'inspect examine' },
      { char: '🤓', name: 'nerd', keywords: 'geek glasses' },
      { char: '😎', name: 'sunglasses', keywords: 'cool' },
      { char: '🥳', name: 'partying', keywords: 'celebrate birthday' },
      { char: '😏', name: 'smirk', keywords: 'smug' },
      { char: '😒', name: 'unamused', keywords: 'meh unimpressed' },
      { char: '😞', name: 'disappointed', keywords: 'sad' },
      { char: '😔', name: 'pensive', keywords: 'sad thoughtful' },
      { char: '😟', name: 'worried', keywords: 'concerned' },
      { char: '🙁', name: 'slight frown', keywords: 'sad' },
      { char: '😣', name: 'persevere', keywords: 'struggle' },
      { char: '😖', name: 'confounded', keywords: 'frustrated' },
      { char: '😫', name: 'tired', keywords: 'exhausted fed up' },
      { char: '😩', name: 'weary', keywords: 'tired done' },
      { char: '🥺', name: 'pleading', keywords: 'puppy eyes please beg' },
      { char: '😢', name: 'crying', keywords: 'sad tear' },
      { char: '😭', name: 'sobbing', keywords: 'cry sad bawling' },
      { char: '😤', name: 'triumph', keywords: 'huff steam determined' },
      { char: '😠', name: 'angry', keywords: 'mad' },
      { char: '😡', name: 'rage', keywords: 'furious mad' },
      { char: '🤬', name: 'swearing', keywords: 'cursing angry' },
      { char: '🤯', name: 'mind blown', keywords: 'shocked wow' },
      { char: '😳', name: 'flushed', keywords: 'embarrassed surprise' },
      { char: '🥵', name: 'hot', keywords: 'heat sweating' },
      { char: '🥶', name: 'cold', keywords: 'freezing' },
      { char: '😱', name: 'screaming', keywords: 'fear shock' },
      { char: '😨', name: 'fearful', keywords: 'scared' },
      { char: '😰', name: 'anxious', keywords: 'nervous worried' },
      { char: '😥', name: 'sad but relieved', keywords: 'phew' },
      { char: '😓', name: 'downcast sweat', keywords: 'hard work' },
      { char: '🤗', name: 'hugging', keywords: 'hug' },
      { char: '🤔', name: 'thinking', keywords: 'hmm consider' },
      { char: '🤭', name: 'hand over mouth', keywords: 'oops giggle' },
      { char: '🤫', name: 'shushing', keywords: 'quiet secret' },
      { char: '🤥', name: 'lying', keywords: 'pinocchio liar' },
      { char: '😶', name: 'no mouth', keywords: 'speechless blank' },
      { char: '😐', name: 'neutral', keywords: 'meh' },
      { char: '😑', name: 'expressionless', keywords: 'blank done' },
      { char: '😬', name: 'grimacing', keywords: 'awkward yikes' },
      { char: '🙄', name: 'eye roll', keywords: 'whatever annoyed' },
      { char: '😴', name: 'sleeping', keywords: 'zzz tired' },
      { char: '🤤', name: 'drooling', keywords: 'want' },
      { char: '😪', name: 'sleepy', keywords: 'tired' },
      { char: '🤢', name: 'nauseated', keywords: 'sick gross' },
      { char: '🤮', name: 'vomiting', keywords: 'sick gross' },
      { char: '🤧', name: 'sneezing', keywords: 'sick cold' },
      { char: '🤒', name: 'thermometer face', keywords: 'sick ill' },
      { char: '😷', name: 'mask', keywords: 'sick ill' },
      { char: '🥴', name: 'woozy', keywords: 'drunk dizzy' },
      { char: '😵', name: 'dizzy', keywords: 'knocked out' },
      { char: '🤠', name: 'cowboy', keywords: 'yeehaw' },
      { char: '👻', name: 'ghost', keywords: 'boo halloween' },
      { char: '💀', name: 'skull', keywords: 'dead dying lol' },
      { char: '👽', name: 'alien', keywords: 'ufo space' },
      { char: '🤖', name: 'robot', keywords: 'bot' },
      { char: '💩', name: 'poop', keywords: 'rubbish bad' },
      { char: '🤡', name: 'clown', keywords: 'joker fool' },
      { char: '😈', name: 'devil', keywords: 'evil mischief' },
    ],
  },
  {
    name: 'Gestures',
    tab: '👍',
    emoji: [
      { char: '👍', name: 'thumbs up', keywords: 'yes agree good ok +1' },
      { char: '👎', name: 'thumbs down', keywords: 'no disagree bad -1' },
      { char: '👌', name: 'ok hand', keywords: 'perfect fine' },
      { char: '🤌', name: 'pinched fingers', keywords: 'italian chef' },
      { char: '✌️', name: 'victory', keywords: 'peace two' },
      { char: '🤞', name: 'fingers crossed', keywords: 'luck hope' },
      { char: '🤟', name: 'love you', keywords: 'ily' },
      { char: '🤘', name: 'rock on', keywords: 'horns metal' },
      { char: '🤙', name: 'call me', keywords: 'shaka hang loose' },
      { char: '👈', name: 'point left' },
      { char: '👉', name: 'point right', keywords: 'this' },
      { char: '👆', name: 'point up', keywords: 'this above' },
      { char: '👇', name: 'point down', keywords: 'below' },
      { char: '☝️', name: 'index up', keywords: 'one wait' },
      { char: '✋', name: 'raised hand', keywords: 'stop high five' },
      { char: '🖐️', name: 'splayed hand', keywords: 'five stop' },
      { char: '🖖', name: 'vulcan salute', keywords: 'spock star trek' },
      { char: '👋', name: 'wave', keywords: 'hello goodbye hi bye' },
      { char: '🤝', name: 'handshake', keywords: 'deal agree' },
      { char: '🙏', name: 'folded hands', keywords: 'please thanks pray' },
      { char: '👏', name: 'clap', keywords: 'applause bravo well done' },
      { char: '🙌', name: 'raised hands', keywords: 'celebrate praise hooray' },
      { char: '👐', name: 'open hands', keywords: 'hug' },
      { char: '🤲', name: 'palms up', keywords: 'beg ask' },
      { char: '✊', name: 'raised fist', keywords: 'solidarity power' },
      { char: '👊', name: 'fist bump', keywords: 'punch bro' },
      { char: '💪', name: 'flexed bicep', keywords: 'strong gym muscle' },
      { char: '🫡', name: 'salute', keywords: 'yes sir respect' },
      { char: '🤦', name: 'facepalm', keywords: 'disbelief oh no' },
      { char: '🤷', name: 'shrug', keywords: 'dunno idk whatever' },
      { char: '💅', name: 'nail polish', keywords: 'sassy fabulous' },
      { char: '🫶', name: 'heart hands', keywords: 'love' },
    ],
  },
  {
    name: 'Hearts',
    tab: '❤️',
    emoji: [
      { char: '❤️', name: 'red heart', keywords: 'love' },
      { char: '🧡', name: 'orange heart' },
      { char: '💛', name: 'yellow heart' },
      { char: '💚', name: 'green heart' },
      { char: '💙', name: 'blue heart' },
      { char: '💜', name: 'purple heart' },
      { char: '🖤', name: 'black heart' },
      { char: '🤍', name: 'white heart' },
      { char: '🤎', name: 'brown heart' },
      { char: '💔', name: 'broken heart', keywords: 'sad breakup' },
      { char: '💕', name: 'two hearts', keywords: 'love' },
      { char: '💖', name: 'sparkling heart', keywords: 'love' },
      { char: '💘', name: 'heart with arrow', keywords: 'cupid love' },
      { char: '💯', name: 'hundred', keywords: 'perfect 100 agree' },
      { char: '💢', name: 'anger', keywords: 'mad' },
      { char: '💥', name: 'collision', keywords: 'boom explode' },
      { char: '💫', name: 'dizzy', keywords: 'star' },
      { char: '⭐', name: 'star', keywords: 'favourite' },
      { char: '🌟', name: 'glowing star', keywords: 'sparkle' },
      { char: '✨', name: 'sparkles', keywords: 'shiny magic clean' },
      { char: '🔥', name: 'fire', keywords: 'lit hot burn' },
      { char: '⚡', name: 'lightning', keywords: 'zap fast power' },
    ],
  },
  {
    name: 'Animals',
    tab: '🐶',
    emoji: [
      { char: '🐶', name: 'dog', keywords: 'puppy' },
      { char: '🐱', name: 'cat', keywords: 'kitten' },
      { char: '🐭', name: 'mouse' },
      { char: '🐹', name: 'hamster' },
      { char: '🐰', name: 'rabbit', keywords: 'bunny' },
      { char: '🦊', name: 'fox' },
      { char: '🐻', name: 'bear' },
      { char: '🐼', name: 'panda' },
      { char: '🐨', name: 'koala' },
      { char: '🐯', name: 'tiger' },
      { char: '🦁', name: 'lion' },
      { char: '🐮', name: 'cow' },
      { char: '🐷', name: 'pig' },
      { char: '🐸', name: 'frog' },
      { char: '🐵', name: 'monkey' },
      { char: '🙈', name: 'see no evil', keywords: 'monkey oops' },
      { char: '🐔', name: 'chicken' },
      { char: '🐧', name: 'penguin' },
      { char: '🐦', name: 'bird' },
      { char: '🦆', name: 'duck' },
      { char: '🦉', name: 'owl' },
      { char: '🐺', name: 'wolf' },
      { char: '🐗', name: 'boar' },
      { char: '🐴', name: 'horse' },
      { char: '🦄', name: 'unicorn' },
      { char: '🐝', name: 'bee' },
      { char: '🐛', name: 'bug', keywords: 'caterpillar' },
      { char: '🦋', name: 'butterfly' },
      { char: '🐌', name: 'snail', keywords: 'slow' },
      { char: '🐙', name: 'octopus' },
      { char: '🦈', name: 'shark' },
      { char: '🐬', name: 'dolphin' },
      { char: '🐳', name: 'whale' },
      { char: '🐢', name: 'turtle' },
      { char: '🐍', name: 'snake' },
      { char: '🦖', name: 'dinosaur', keywords: 'trex' },
      { char: '🌵', name: 'cactus' },
      { char: '🌲', name: 'tree', keywords: 'evergreen' },
      { char: '🌻', name: 'sunflower' },
      { char: '🌹', name: 'rose', keywords: 'flower' },
      { char: '🍀', name: 'four leaf clover', keywords: 'luck' },
      { char: '🌈', name: 'rainbow' },
      { char: '☀️', name: 'sun', keywords: 'sunny' },
      { char: '🌙', name: 'crescent moon', keywords: 'night' },
      { char: '☁️', name: 'cloud' },
      { char: '🌧️', name: 'rain' },
      { char: '❄️', name: 'snowflake', keywords: 'cold snow' },
    ],
  },
  {
    name: 'Food',
    tab: '🍕',
    emoji: [
      { char: '🍕', name: 'pizza' },
      { char: '🍔', name: 'burger' },
      { char: '🍟', name: 'chips', keywords: 'fries' },
      { char: '🌭', name: 'hot dog' },
      { char: '🌮', name: 'taco' },
      { char: '🌯', name: 'burrito' },
      { char: '🍜', name: 'noodles', keywords: 'ramen' },
      { char: '🍣', name: 'sushi' },
      { char: '🍱', name: 'bento' },
      { char: '🍛', name: 'curry' },
      { char: '🥗', name: 'salad' },
      { char: '🥪', name: 'sandwich' },
      { char: '🍞', name: 'bread' },
      { char: '🧀', name: 'cheese' },
      { char: '🥓', name: 'bacon' },
      { char: '🍳', name: 'fried egg', keywords: 'cooking breakfast' },
      { char: '🥞', name: 'pancakes' },
      { char: '🍎', name: 'apple' },
      { char: '🍌', name: 'banana' },
      { char: '🍓', name: 'strawberry' },
      { char: '🍇', name: 'grapes' },
      { char: '🍉', name: 'watermelon' },
      { char: '🍑', name: 'peach' },
      { char: '🥑', name: 'avocado' },
      { char: '🍰', name: 'cake', keywords: 'slice' },
      { char: '🎂', name: 'birthday cake' },
      { char: '🍪', name: 'cookie', keywords: 'biscuit' },
      { char: '🍫', name: 'chocolate' },
      { char: '🍩', name: 'doughnut' },
      { char: '🍿', name: 'popcorn', keywords: 'drama watching' },
      { char: '☕', name: 'coffee', keywords: 'tea hot drink' },
      { char: '🍺', name: 'beer', keywords: 'pint pub' },
      { char: '🍻', name: 'cheers', keywords: 'beers toast' },
      { char: '🍷', name: 'wine' },
      { char: '🥂', name: 'clinking glasses', keywords: 'celebrate toast' },
      { char: '🍾', name: 'champagne', keywords: 'celebrate pop' },
      { char: '🧋', name: 'bubble tea', keywords: 'boba' },
      { char: '🥤', name: 'soft drink', keywords: 'cup soda' },
    ],
  },
  {
    name: 'Activity',
    tab: '🎮',
    emoji: [
      { char: '🎮', name: 'game controller', keywords: 'gaming play' },
      { char: '🕹️', name: 'joystick', keywords: 'arcade retro' },
      { char: '🎧', name: 'headphones', keywords: 'listening music' },
      { char: '🎤', name: 'microphone', keywords: 'sing karaoke' },
      { char: '🎵', name: 'music note', keywords: 'song' },
      { char: '🎶', name: 'music notes', keywords: 'song singing' },
      { char: '🎸', name: 'guitar' },
      { char: '🥁', name: 'drum' },
      { char: '🎹', name: 'keyboard', keywords: 'piano' },
      { char: '🎬', name: 'clapper board', keywords: 'film movie action' },
      { char: '📺', name: 'television', keywords: 'tv watching' },
      { char: '🎨', name: 'art', keywords: 'paint palette' },
      { char: '📚', name: 'books', keywords: 'reading study' },
      { char: '⚽', name: 'football', keywords: 'soccer' },
      { char: '🏀', name: 'basketball' },
      { char: '🏈', name: 'american football' },
      { char: '🎾', name: 'tennis' },
      { char: '🏐', name: 'volleyball' },
      { char: '🏓', name: 'table tennis', keywords: 'ping pong' },
      { char: '🎱', name: 'pool', keywords: '8 ball snooker' },
      { char: '🎯', name: 'bullseye', keywords: 'darts target exactly' },
      { char: '🎲', name: 'dice', keywords: 'random game' },
      { char: '♟️', name: 'chess pawn', keywords: 'strategy' },
      { char: '🏆', name: 'trophy', keywords: 'win champion' },
      { char: '🥇', name: 'gold medal', keywords: 'first win' },
      { char: '🎉', name: 'party popper', keywords: 'celebrate congrats hooray' },
      { char: '🎊', name: 'confetti', keywords: 'celebrate' },
      { char: '🎁', name: 'gift', keywords: 'present birthday' },
      { char: '🎈', name: 'balloon', keywords: 'party' },
      { char: '🚀', name: 'rocket', keywords: 'launch ship fast' },
      { char: '🏕️', name: 'camping', keywords: 'tent outdoors' },
      { char: '🚗', name: 'car', keywords: 'drive' },
      { char: '✈️', name: 'aeroplane', keywords: 'flight travel' },
      { char: '🏠', name: 'house', keywords: 'home' },
    ],
  },
  {
    name: 'Objects',
    tab: '💻',
    emoji: [
      { char: '💻', name: 'laptop', keywords: 'computer work coding' },
      { char: '🖥️', name: 'desktop computer', keywords: 'pc monitor' },
      { char: '⌨️', name: 'keyboard', keywords: 'typing' },
      { char: '🖱️', name: 'mouse', keywords: 'click' },
      { char: '📱', name: 'phone', keywords: 'mobile' },
      { char: '☎️', name: 'telephone', keywords: 'call' },
      { char: '💾', name: 'floppy disk', keywords: 'save old' },
      { char: '💡', name: 'light bulb', keywords: 'idea' },
      { char: '🔋', name: 'battery', keywords: 'power' },
      { char: '🔌', name: 'plug', keywords: 'power electric' },
      { char: '🔧', name: 'spanner', keywords: 'fix tool wrench' },
      { char: '🔨', name: 'hammer', keywords: 'build fix' },
      { char: '🛠️', name: 'tools', keywords: 'fix build' },
      { char: '🧹', name: 'broom', keywords: 'clean sweep' },
      { char: '🔒', name: 'locked', keywords: 'secure private' },
      { char: '🔓', name: 'unlocked', keywords: 'open' },
      { char: '🔑', name: 'key', keywords: 'access' },
      { char: '📌', name: 'pin', keywords: 'pinned important' },
      { char: '📎', name: 'paperclip', keywords: 'attach file' },
      { char: '📝', name: 'memo', keywords: 'note write' },
      { char: '📅', name: 'calendar', keywords: 'date schedule' },
      { char: '⏰', name: 'alarm clock', keywords: 'time wake' },
      { char: '⏳', name: 'hourglass', keywords: 'waiting time' },
      { char: '💰', name: 'money bag', keywords: 'cash rich' },
      { char: '💳', name: 'card', keywords: 'pay credit' },
      { char: '📦', name: 'package', keywords: 'box delivery' },
      { char: '🔍', name: 'magnifying glass', keywords: 'search find look' },
      { char: '🔔', name: 'bell', keywords: 'notification alert' },
      { char: '🔕', name: 'bell off', keywords: 'mute silent' },
      { char: '📢', name: 'loudspeaker', keywords: 'announce shout' },
      { char: '🎙️', name: 'studio microphone', keywords: 'podcast recording' },
      { char: '📸', name: 'camera', keywords: 'photo picture' },
      { char: '🧪', name: 'test tube', keywords: 'science experiment' },
      { char: '💊', name: 'pill', keywords: 'medicine' },
      { char: '🛒', name: 'trolley', keywords: 'shopping cart buy' },
      { char: '🗑️', name: 'wastebasket', keywords: 'bin delete rubbish trash' },
    ],
  },
  {
    name: 'Symbols',
    tab: '✅',
    emoji: [
      { char: '✅', name: 'tick', keywords: 'check done yes correct' },
      { char: '❌', name: 'cross', keywords: 'no wrong cancel' },
      { char: '❗', name: 'exclamation', keywords: 'important warning' },
      { char: '❓', name: 'question', keywords: 'ask what' },
      { char: '⚠️', name: 'warning', keywords: 'caution careful' },
      { char: '🚫', name: 'prohibited', keywords: 'no ban forbidden' },
      { char: '♻️', name: 'recycle', keywords: 'reuse green' },
      { char: '➕', name: 'plus', keywords: 'add' },
      { char: '➖', name: 'minus', keywords: 'subtract remove' },
      { char: '➡️', name: 'right arrow', keywords: 'next' },
      { char: '⬅️', name: 'left arrow', keywords: 'back previous' },
      { char: '⬆️', name: 'up arrow' },
      { char: '⬇️', name: 'down arrow' },
      { char: '🔄', name: 'refresh', keywords: 'reload sync repeat' },
      { char: '🔗', name: 'link', keywords: 'url chain' },
      { char: '💬', name: 'speech bubble', keywords: 'chat message talk' },
      { char: '💭', name: 'thought bubble', keywords: 'thinking' },
      { char: '🔇', name: 'muted', keywords: 'silent no sound' },
      { char: '🔊', name: 'loud', keywords: 'volume sound speaker' },
      { char: '🆗', name: 'ok', keywords: 'fine' },
      { char: '🆕', name: 'new' },
      { char: '🔞', name: 'eighteen', keywords: 'nsfw adult' },
      { char: '💤', name: 'zzz', keywords: 'sleep tired afk' },
      { char: '🏳️', name: 'white flag', keywords: 'surrender give up' },
      { char: '🏁', name: 'chequered flag', keywords: 'finish race done' },
    ],
  },
];

/** Everything, flat, for search. */
export const ALL_EMOJI: Emoji[] = EMOJI_GROUPS.flatMap((group) => group.emoji);

/**
 * Search by name and keywords.
 *
 * Ranked so an exact name wins, then a name that starts with the query, then
 * anything that merely contains it - otherwise typing "cat" puts "cathedral"
 * style near-misses above the cat.
 */
export function searchEmoji(query: string, limit = 60): Emoji[] {
  const q = query.trim().toLowerCase().replace(/^:+|:+$/g, '');
  if (!q) return [];

  const scored: Array<{ emoji: Emoji; score: number }> = [];
  for (const emoji of ALL_EMOJI) {
    const name = emoji.name.toLowerCase();
    const words = `${name} ${emoji.keywords ?? ''}`.trim().toLowerCase();

    let score = -1;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (words.split(/\s+/).some((word) => word === q)) score = 2;
    else if (words.split(/\s+/).some((word) => word.startsWith(q))) score = 3;
    else if (words.includes(q)) score = 4;

    if (score >= 0) scored.push({ emoji, score });
  }

  return scored
    .sort((a, b) => a.score - b.score || a.emoji.name.length - b.emoji.name.length)
    .slice(0, limit)
    .map((entry) => entry.emoji);
}

const RECENT_KEY = 'chitchak.emoji.recent';
const RECENT_MAX = 24;

export function recentEmoji(): Emoji[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const chars = JSON.parse(raw) as string[];
    // Looked up rather than stored whole, so an emoji dropped from the
    // catalogue disappears from recents instead of lingering as a bare
    // character with no name to search by.
    return chars
      .map((char) => ALL_EMOJI.find((emoji) => emoji.char === char))
      .filter((emoji): emoji is Emoji => Boolean(emoji));
  } catch {
    return [];
  }
}

export function rememberEmoji(char: string): void {
  try {
    const chars = [char, ...recentEmoji().map((e) => e.char).filter((c) => c !== char)];
    localStorage.setItem(RECENT_KEY, JSON.stringify(chars.slice(0, RECENT_MAX)));
  } catch {
    // A full or unavailable localStorage is not a reason to fail to send.
  }
}
