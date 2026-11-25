// Protection par mot de passe : chiffrement et déchiffrement d'un PDF.
// S'appuie sur @cantoo/pdf-lib (MIT), une variante de pdf-lib qui sait chiffrer. Elle n'est chargée
// que pour ces deux opérations ; le reste de l'application garde la bibliothèque d'origine.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(() => require('@cantoo/pdf-lib'));
  else root.Protect = factory(() => root.Protect.library);
})(typeof self !== 'undefined' ? self : this, function (library) {
  // Chiffre le document (AES 256 bits). Le mot de passe est demandé à l'ouverture.
  async function encrypt(bytes, password) {
    if (!password) throw new Error('Indiquez un mot de passe.');
    const doc = await library().PDFDocument.load(bytes);
    doc.encrypt({ userPassword: password, ownerPassword: password, permissions: { printing: 'highResolution', modifying: true, copying: true, annotating: true, fillingForms: true } });
    return doc.save();
  }

  // Rend une copie non chiffrée, à partir du bon mot de passe.
  async function decrypt(bytes, password) {
    let doc;
    try {
      doc = await library().PDFDocument.load(bytes, { password });
    } catch (err) {
      throw new Error('Mot de passe incorrect.');
    }
    return doc.save();
  }

  return { encrypt, decrypt };
});
