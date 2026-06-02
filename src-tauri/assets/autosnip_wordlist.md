# AutoSnip wordlist

Edit this file freely. Lines that start with `#` are comments and ignored.

## Format

Each section header has the form:

    ## <category-name> : <bucket> [ : <default-action> ]

- **bucket** is either `snip` (creates an auto-flag AND an auto-snip) or
  `flag` (only drops a flag at the subtitle entry's start time — no snip).
- **default-action** applies only to `snip` buckets, and chooses what the
  auto-snip does at playback time. One of: `skip`, `silence`, `freeze`,
  `replace`. (`replace` = audio-replace; currently treated as silence
  while the proper implementation is built — see the stubs list.)

Below the header, list keywords / phrases separated by commas or one per
line. Whitespace is trimmed. Matches are case-insensitive. Single words
match whole-word only (subtitle "passion" won't match `ass`). Multi-word
phrases match as substrings (so phrase order matters).

A word can appear in multiple categories — each match generates its own
flag, so the same subtitle line can be flagged for multiple reasons.

Implementation: make sure that words that could be part of a compound or larger word are regex-ready and require a space before and after, e.g. "dam" could easily be part of "Damsel" or whatnot.

Also, if two categories conflict, do the one that's the most restrictive (i.e. if Cat 1 is flag only, and Cat 2 is flag + silence snip, then do Cat 2) AND flag that snip as BOTH categories if relevant (i.e. if it's ). That being said, don't require all words to be exact mataches: obviously case doesn't matter, and I want "dick" to include "dicks", "dick-down" etc.

---

## language : snip : silence
fuck, fucks, fucking, fucker, fucked, motherfucker, mofo
clusterfuck, dumbfuck
shit, shitting, shithead, shithole, shitface, bullshit, shitty, shitter, shite, dipshit
ass, asshole, jackass
bitch, bitches, son of a bitch
piss, pissed, pissing
dick, dickhead
cunt, twat, cunny
prick, dickhead
arse, arsehole
hell
damn, dam, damnit, goddamn, god damn, god damn it
slut
butthole
dildo
jizz

## language-mild : flag
crap, crappy, crapping
screw, screwed, screwing
whore
wanker
arse
idiot
stupid
strumpet
douche


## sex : snip : silence
sex, sexual, sexually
porn, pornography, pornographic
naked, nude, nudity
breast, breasts, boob, boobs, tit, tits, nipple, nipples
penis, dick, cock, balls, testicle, bollock
vagina, pussy
orgasm, orgasming, climax, cum, cumming
masturbate, masturbating, masturbation
erection, hard-on
ejaculate, ejaculating
genitals
oral sex
fellatio
blowjob
handjob
threesome
cuckold
hook up
jerkoff, jerking off

## sex-references : flag
seduce, seduction, seductive
sleep with, sleeping with, slept with
hook up, hooked up, hooking up
one night stand
in bed with, in bed together
make love, making love
foreplay
turn on, turned on, turn-on
strip, stripping, stripper
intercourse
cleavage
get laid, getting laid, laid
grope
fondle
copulate
sex tape
upskirt
strip club
kinky
rape, rapist
molest
violate
twerk, twerking
two chicks


## blasphemy : snip : skip
jesus christ, christ almighty
god damn it, goddamnit
holy shit
oh my god
gawd
holy mother of god, mother of god
bejesus



## violence : flag
murder, murdered, murdering, murderer
kill, killed, killing, killer
rape, raped, raping, rapist
blood, bloody, bleeding
shoot, shot, shooting, gunshot, gunfire
stab, stabbed, stabbing, knife
torture, tortured, torturing
beat up, beaten, beating up
strangle, strangled, strangling
choke, choked, choking
mutilate
butcher
slaughter
punch
kick
whip
flog


## drug-references : flag
cocaine, coke, snorting
heroin, smack
meth, methamphetamine
weed, marijuana, pot, joint, blunt, getting high, stoned
ecstasy, molly
acid, lsd
crack
opioid, opioids, oxy, oxycontin
overdose, OD
nose candy

## alcohol : flag
drunk, drunken
wasted, hammered, plastered
whiskey, vodka, tequila, gin
binge drinking

## agenda: feminism : flag
patriarchy, patriarchal, patriarchal 
toxic masculinity
male privilege
mansplain, mansplaining
feminist, feminism, feminists
girl power
girl boss
pay gap, wage gap, gender wage gap
body shaming, slut shaming
rape culture
women's rights, reproductive rights, pro-choice, war on women
sisterhood
women's liberation, women's suffrage, suffrage, suffragette
damsel in distress
the future is female
incel

## agenda: LGBTQUIA+ : flag
homosexual, homosexuality
same-sex
heterosexual, hetero
gay, gays
lesbian, lesbians
transgender, transsexual, trans, tranny
queer
bisexual, bi
nonbinary, non-binary
pronouns, they/them
gender identity
drag queen, drag show, drag king
intersectionality, intersectional
patriarchal, heteronormative, androcentrism
discrimination
come out of the closet, coming out of the closet
genderqueer, genderfluid, gender fluid
gender affirming
deadname, deadnaming
safe space
domestic partnership, civil union
drag ban
transphobia, transphobic
fag, faggot


## agenda: socialism : flag
socialism, socialist
marxism, marxist
communism, communist
class struggle
bourgeoisie, proletariat
capitalism is, capitalism has
redistribution of wealth

## agenda: atheism : flag
there is no god
no such thing as god
religion
religious nonsense
believer, believers
atheist, atheism

## other : other : flag
suicide
retard

# (Left empty by default; edit to populate.)
