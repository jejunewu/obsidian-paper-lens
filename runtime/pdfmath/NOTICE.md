# Local translation runtime

Paper Lens invokes unmodified open-source packages in a separate Python process.
The bridge implements progress, cancellation and artifact validation; upstream
packages implement recognition, paragraph translation and PDF typesetting.

- PDFMathTranslate-next 2.9.0 (AGPL-3.0):
  https://github.com/PDFMathTranslate/PDFMathTranslate-next/tree/v2.9.0
  Source distribution: https://pypi.org/project/pdf2zh-next/2.9.0/#files
- BabelDOC 0.6.2 (AGPL-3.0):
  https://github.com/funstory-ai/BabelDOC
  Source distribution: https://pypi.org/project/babeldoc/0.6.2/#files
- PyMuPDF 1.25.2 (AGPL-3.0 or commercial):
  https://github.com/pymupdf/PyMuPDF/tree/1.25.2
  https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright

AGPL license texts are included alongside this notice. Python wheels and their
license metadata are installed on demand, not embedded in the plugin zip.
Model weights and fonts are downloaded by BabelDOC and retain their own licenses.
The model API is separately configured by the user and may incur service charges.
