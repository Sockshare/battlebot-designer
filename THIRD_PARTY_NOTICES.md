# Third-party notices

BattleBot Designer bundles the third-party files listed below. Nothing is loaded from a CDN or any
other remote host: `templates/index.html` references only `/static/...` paths, and `static/bb.css`
loads the fonts with `@font-face` rules that point at local files under `/static/fonts/`.

How the entries below were established:

- **three.js** — from the licence header and the revision constant inside `static/three.min.js`.
- **Fonts** — from the `name` table embedded in each `.woff2` file (copyright, version and licence
  URL records). The font files carry a licence URL but not the licence text itself.
- The SHA-256 of each file is given so the exact bundled bytes can be compared against an upstream
  release. That comparison has **not** been done; see "Not determined" under each entry.

The Python dependency (Flask and its dependencies, see `requirements.txt`) is installed by `pip` at
setup time and is not redistributed in this repository, so it is not listed here.

---

## 1. three.js

| | |
|---|---|
| File | `static/three.min.js` |
| Version | r128 (the file sets `REVISION` to `"128"`; npm equivalent `three@0.128.0`) |
| Source | https://github.com/mrdoob/three.js (tag `r128`, `build/three.min.js`) — https://threejs.org/ |
| Licence | MIT (`SPDX-License-Identifier: MIT` in the file header) |
| SHA-256 | `9274bbcec8d96168626c732b5d31c775aa8cfb7eaa0599bec0c175908a2c1ce2` |

Header as it appears in the file:

```
/**
 * @license
 * Copyright 2010-2021 Three.js Authors
 * SPDX-License-Identifier: MIT
 */
```

Not determined: the file has not been compared byte-for-byte with the upstream r128 build, so it is
not confirmed to be unmodified.

Licence text (MIT, with the copyright line from the file header):

```
The MIT License

Copyright 2010-2021 Three.js Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## 2. Inter (variable font, Latin subset)

| | |
|---|---|
| File | `static/fonts/inter-latin-wght-normal.woff2` |
| Version | 4.001 (embedded version string: `Version 4.001;git-66647c0bb`) |
| Source | https://github.com/rsms/inter — https://rsms.me/inter/ |
| Licence | SIL Open Font License, Version 1.1 (embedded licence URL: `https://openfontlicense.org`) |
| Copyright (embedded) | `Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)` |
| SHA-256 | `f052ee44c3728dfd23aba8a4567150bc314d23903026fbb6ad089422c2df56af` |

Not determined from the files:

- Which distribution this subset file came from. The file name follows the naming pattern used by the
  Fontsource packages (`@fontsource-variable/inter`), but that is an inference from the name only; the
  package and its version are unknown.
- Whether the upstream `OFL.txt` for this release declares a Reserved Font Name. The font file does
  not contain that information. Check the upstream licence file before publishing.

The licence text is reproduced once in section 4.

---

## 3. JetBrains Mono (Latin subset; weights 400, 600, 700)

| | |
|---|---|
| Files | `static/fonts/jetbrains-mono-latin-400-normal.woff2`, `static/fonts/jetbrains-mono-latin-600-normal.woff2`, `static/fonts/jetbrains-mono-latin-700-normal.woff2` |
| Version | 2.211 (embedded version string in all three files: `Version 2.211`) |
| Source | https://github.com/JetBrains/JetBrainsMono — https://www.jetbrains.com/lp/mono/ |
| Licence | SIL Open Font License, Version 1.1 (embedded licence URL: `https://scripts.sil.org/OFL`) |
| Copyright (embedded) | `Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)` |
| SHA-256 (400) | `7c53386f55c866c1b4c9309c4bcf74eda10896aab3a1780b0af5cc4976e27a27` |
| SHA-256 (600) | `1cd6778760d101a5c522f5d1de6fe17efa9e66950bcd5fce274ae3b4f494f923` |
| SHA-256 (700) | `ed8b8f71b22bf3b6e1ec1cf9b24dd999785aae33d6256950c1f86c97e423b6ef` |

Not determined from the files:

- Which distribution these subset files came from. The file names follow the naming pattern used by
  the Fontsource packages (`@fontsource/jetbrains-mono`), but that is an inference from the names only;
  the package and its version are unknown.
- Whether the upstream `OFL.txt` for this release declares a Reserved Font Name. The font files do
  not contain that information. Check the upstream licence file before publishing.

The licence text is reproduced once in section 4.

---

## 4. SIL Open Font License, Version 1.1

Applies to the Inter and JetBrains Mono font files listed in sections 2 and 3, under the copyright
notices given there.

```
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

The MIT and OFL texts above are the standard published texts of those licences, written out here
because the bundled files contain only a licence identifier (three.js) or a licence URL (fonts).
They have not been diffed against the upstream `LICENSE` / `OFL.txt` files of these exact releases.
