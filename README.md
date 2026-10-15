# WTF.js

```js
// moin und guten tag!
const greeting = 'moin und guten tag!';
const greeting = wtf.str('moin und guten tag!');
const greeting = wtf.str[' ']('moin', 'und', 'guten', 'tag!');

// bird, cat, dog
const list = wtf.str[', ']('bird', 'cat', 'dog');
```

---

# LSD | lazy stupid dev

```js
import { lsd } from 'wtf.js';

## `fn`

tell the compiler to build a helper function.

```js
const normalizeKey = lsd.fn('trim toLowerCase');
```

