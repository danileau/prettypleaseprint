The four faces this app renders in, vendored as woff2.

They used to come from `next/font/google`, which downloads them at build time.
That made every image build — CI's `verify` gate, `release-images.yml`, and the
README's own build-from-source quick start — depend on fonts.googleapis.com
being reachable and willing. It failed exactly that way once, and the error
surfaces as a webpack stack trace about a font loader, which is not where anyone
looks first.

It was also inconsistent: Swagger UI is vendored out of node_modules precisely
because "a CDN would be unreachable on a NAS with no outbound internet", and the
app's own typefaces did not get the same treatment.

Nothing here is fetched at build or at runtime. `src/app/layout.tsx` loads these
files through `next/font/local`, which is why the CSP can keep font-src at
'self'.

  pacifico-400.woff2          the script logotype
  alfa-slab-one-400.woff2     headings, the "EAT" sign face
  archivo-100-900.woff2       body text — one variable file covers 400/500/600/700
  courier-prime-400.woff2     dockets: refs, filenames, dimensions
  courier-prime-700.woff2     the same, bold

Latin subset only, which is what the app asked Google for before. To refresh
them, take the woff2 the Google Fonts CSS API serves for the latin block of each
family — but check whether the design still wants that face first, because a
silent typeface change is worse than a stale one.

--------------------------------------------------------------------------------
LICENCE

All four are licensed under the SIL Open Font License, Version 1.1, which
permits redistribution provided this notice travels with the files.

Pacifico — Copyright 2018 The Pacifico Project Authors (https://github.com/googlefonts/Pacifico)
Alfa Slab One — Copyright 2016 The Alfa Slab One Project Authors (http://www.jmsole.cl | info@jmsole.cl), with Reserved Font Name "Alfa Slab".
Archivo — Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)
Courier Prime — Copyright 2015 The Courier Prime Project Authors (https://github.com/quoteunquoteapps/CourierPrime).
--------------------------------------------------------------------------------

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


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
