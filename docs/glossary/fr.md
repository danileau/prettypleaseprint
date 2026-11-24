# French glossary

For whoever maintains [`messages/fr.json`](../../messages/fr.json). The
wording comes from an instance that has run in French since October 2026; keep
it consistent rather than re-deriving each word. The voice is a 1950s diner —
in French a *bistrot* kitchen, not a dictionary: the word a French cook or
waiter would say, where one exists.

## Words

| English | French | Note |
|---|---|---|
| The rail | **le rail** | Tickets hang on a rail in French kitchens too. Not *les bons*, which on a menu reads as "the good ones". |
| The pass | **le passe** | Masculine, the kitchen's word for the counter where a plate is checked before it goes out. |
| Order up | **Passer commande** | *Ça marche !* answers an order rather than placing one, and as a link reads "it works". |
| My orders | **Mes commandes** | |
| The books | **La caisse** | The till; *les comptes* would collide with people's accounts. |
| Feature requests | **Boîte à idées** | The suggestion box. A request filed there is *glissée dans la boîte*. |
| Benefits | **Pourboires** | |
| Guest list | **Liste des invités** | |
| Materials | **Matières** | |
| Audit | **Journal** | |
| Mail (the page, the system) | **Courrier** | *Un e-mail* for one message, *par e-mail* for the channel. |
| Activity (panel) | **le panneau Activité** | |
| Members only · ask at the counter | **Réservé aux habitués · demandez au comptoir** | |
| What’ll it be? | **Qu’est-ce que je vous sers ?** | |
| Your table is ready / Claim your seat | **Votre table est prête / Prendre place** | |
| Out the door (Mail kicker) | **À emporter** | Takeaway: what leaves the diner by the door. |
| whoever owns the printer | **la personne qui s’occupe de l’imprimante** | Neutral, no agreement; *le propriétaire* sounds like a landlord. |
| Printer owner / Invited member (role labels) | **Propriétaire de l’imprimante / Membre invité** | Labels, so plain. |
| passkey | **clé d’accès** | The term Apple, Google and Microsoft use in French. |
| single sign-on | **l’authentification unique** | Its default name carries the article: it is dropped into “Se connecter avec {name}”. |
| sign-on provider | **fournisseur d’identité** | |
| connect / disconnect (an SSO identity) | **associer / dissocier** | Phrased so nothing agrees with `{name}`: “Votre compte est associé à {name}”, never “{name} est connecté(e)”. |
| ticket statuses | **Demandé / Accepté / En impression / À remettre / Terminé / Refusé** | *Un ticket*, masculine. |
| request statuses | **Demandée / Acceptée / En cours / Livrée / Terminée / Refusée** | *Une demande*, feminine. *Shipped* is *Livrée*. |
| Priority low / medium / high | **basse / normale / haute** | *Normale*, not *moyenne*. |
| nothing to phish | **rien à se faire voler** | *Hameçonner* is jargon to the people this is for. |
| just now | **à l’instant** | |
| Subject (of an email) | **Objet** | |
| test message | **message d’essai** | |

## Voice and typography

- **Vous** everywhere, as a waiter to a customer. Switching to *tu* would be a
  change to the whole file at once, never key by key.
- The masculine generic for the reader (*invité*, *ajouté*) where agreement
  cannot be avoided; avoid it where it can (*la personne qui…*).
- Apostrophe **’** (U+2019), never ASCII `'` — ICU reads `'{` as a quote.
- **U+202F** (narrow no-break space) before `?`, `!` and `;`; **U+00A0**
  (no-break space) before `:` and inside guillemets `« … »`. English “…” quotes
  become `« … »`. The characters are written raw in the JSON, not escaped.
- Emails are read in mail clients, often on a phone: short sentences, warm,
  no jargon. Banners and pills stay in capitals, as in English.
- A `select` may move the whole sentence into its branches when French word
  order needs it (`notification.storyMoved`), as long as every English branch
  key, `other` included, is kept.
- Variable names, environment variables, file names and *Pretty Please Print*
  stay as they are.
