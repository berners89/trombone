# Trombone

Lecteur et éditeur PDF gratuit et libre pour Windows : lecture, modification du texte (y compris des scans, par OCR), conversions Word, Excel et images, formulaires, commentaires, protection par mot de passe. Tout se passe sur l'ordinateur : aucun document n'est envoyé sur Internet.

Licence MIT. Anciennement « Feuillet ».

## Lancer

Prérequis : Node.js 20 ou plus récent.

    npm install
    npm start

Générer l'installateur Windows (dossier `dist/`) :

    npm run dist

## Ce que fait cette version

- Affichage : miniatures, zoom, ajustement à la largeur, recherche, signets, sélection et copie du texte.
- Annuler / rétablir (Ctrl+Z, Ctrl+Y) sur toutes les modifications, y compris les opérations sur les pages.
- Annotations : surlignage, texte, dessin à main levée, gomme.
- Texte existant (outil « Modifier ») : modification par bloc avec retour à la ligne, choix de la police,
  du gras, de l'italique, de la taille et de la couleur ; déplacement des blocs avec repères d'alignement.
  La police d'origine est reconnue, l'ancien texte est supprimé du fichier et le nouveau est écrit dans
  une police libre équivalente, embarquée en entier (Liberation Sans pour Arial/Helvetica, Tinos pour
  Times, Liberation Mono pour Courier, Carlito pour Calibri).
- OCR en français des pages scannées, sur le poste ; un scan devient cherchable, modifiable, et ses blocs
  se déplacent en conservant leur aspect (c'est le morceau d'image qui bouge).
- Images et signature : insertion d'une image, signature dessinée, déplacement et redimensionnement.
- Pages : réorganisation par glisser des miniatures, rotation, suppression, page blanche, insertion d'un
  autre PDF, extraction par plage (« 1-3, 5 »), fusion, numérotation, filigrane.
- Conversions fidèles, dans les deux sens (`src/office.js`, sans dépendance) :
  - PDF vers Word : chaque page garde son fond en image (couleurs, traits, logos) et le texte est reposé
    par-dessus dans des cadres, à sa place, avec police, taille, gras, italique et couleur.
    Une variante « texte seul » produit un document fluide.
  - PDF vers Excel : colonnes retrouvées, montants en nombres, gras, couleurs et fonds des cellules.
  - Word vers PDF : couleurs, fonds, filets, soulignements, images, tableaux (largeurs, fonds, bordures),
    format et marges de page.
  - Excel vers PDF : couleurs, fonds, gras, alignements, bordures, largeurs, cellules fusionnées, formats.
  - Images vers PDF, pages vers PNG.
- Formulaires : les champs d'un PDF (texte, case à cocher, liste, boutons radio) se remplissent à l'écran
  et les valeurs sont enregistrées dans le fichier.
- Polices : 25 familles libres embarquées (100 fichiers, voir `fonts/LICENCES.txt`), dont les équivalents
  d'Arial, Times, Courier, Calibri, Cambria, Georgia, Verdana, Arial Narrow, Garamond et Comic Sans, plus
  Roboto, Open Sans, Lato, Montserrat, Noto, Poppins, etc. Inventaire des polices du document.
- Sécurité : caviardage (la page est remplacée par son image, le contenu d'origine est retiré du fichier),
  enregistrement avec mot de passe (AES 256 bits), ouverture des PDF protégés, compression des images.

L'enregistrement crée toujours une copie : l'original n'est jamais écrasé sans confirmation.
Les annotations sont intégrées au contenu de la page à l'enregistrement.

### Version 1.1 : interface

Nouvelle identité (encre violette et feuille à réglure Seyès), colonne d'outils à icônes, menu Outils rangé par usage, nom du document dans la barre, icône de l'application. `.github/workflows/windows.yml` compile l'installateur sur un Windows de GitHub (non essayé tant que le dépôt n'existe pas).

### Ajouts de la version 1.0

- **Police absente : reconnaissance et suggestion.** À la modification d'un texte, Trombone lit le nom de la police d'origine et indique s'il l'a (exacte), s'il en a un équivalent libre (« Times → Tinos ») ou, sinon, quelle police proche il propose (« Futura → Poppins »). Le choix reste modifiable dans la barre de style.
- **Commentaires PDF** (outil Commenter, panneau Commentaires) : de vraies notes, lisibles dans Adobe Reader.
- **Création de champs de formulaire** : champ de texte et case à cocher.
- **Impression** (application Windows seulement).
- **Langue de l'OCR** : français, français + anglais, anglais, allemand, espagnol, italien.
- Non prévu : la signature certifiée.

## Compiler pour Windows

Sur un PC Windows avec Node.js :

    npm install
    npm run dist

`dist/` contient alors l'installateur (`Trombone-Installation-1.1.0.exe`) et la version portable en un seul fichier. Depuis Linux sans Wine, seule l'application décompressée (`dist/win-unpacked`) est produite : c'est elle qui est distribuée en zip. L'exécutable n'est pas signé : Windows SmartScreen affiche un avertissement au premier lancement.

## Organisation

- `main.js`, `preload.js` : fenêtre, protocole local `app://`, dialogues de fichiers.
- `src/pdfops.js` : moteur (octets PDF en entrée, octets PDF en sortie), testable sans interface.
- `src/app.mjs` : interface.
- `test/test-ops.js` : tests du moteur (`npm test`).
- `test/e2e.js` : essai de l'interface avec capture d'écran.
- `test/test-real.mjs` : modification de texte sur des PDF LibreOffice, LaTeX, wkhtmltopdf et ReportLab.
- `fonts/` : polices libres embarquées et leurs licences.
- `ocr/` : moteur Tesseract et modèle français, généré par `scripts/prepare-ocr.js` après `npm install`.
- `test/e2e-ocr.js` : essai de l'OCR sur un PDF scanné.
- `test/test-office.js`, `test/e2e-office.js` : conversions Word / Excel et formulaires.
- `test/e2e-security.js` : caviardage, mot de passe, compression, choix de police.
- `src/protect.js` : chiffrement et déchiffrement (bibliothèque @cantoo/pdf-lib, MIT).
- `test/e2e-features.js` : essai des pages, de l'historique, de la signature, du style et de la sélection.
- `src/blocks.js` : regroupement du texte en blocs et remise en page.

## Briques et licences

Electron (MIT), pdf.js (Apache 2.0), pdf-lib, @cantoo/pdf-lib et fontkit (MIT), Tesseract.js (Apache 2.0). Polices sous licence SIL OFL. Aucune dépendance copyleft.

## Version navigateur

`npm run build:web` génère dans `web/` une version qui tourne dans un navigateur, sans installation.
La couche plateforme est isolée : `src/platform.js` (Electron) et `src/platform-web.js` (navigateur)
fournissent les mêmes fonctions à `src/app.mjs`. `test/e2e-web.js` teste cette version.

## Code signing policy

Politique de signature du code. Les exécutables Windows sont compilés par GitHub Actions à partir de ce dépôt (`.github/workflows/windows.yml`), sans étape manuelle. Chaque version signée est approuvée à la main.

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org) (demande en cours : les versions actuelles ne sont pas encore signées).

- Committers and reviewers : [Berners](https://github.com/berners89)
- Approvers : [Berners](https://github.com/berners89)

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

Trombone ne transmet aucune information à un autre système en réseau. Les documents sont lus, modifiés et enregistrés uniquement sur l'ordinateur de l'utilisateur ; l'application ne contient ni télémétrie ni mise à jour automatique.
