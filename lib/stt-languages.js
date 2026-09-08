// Canonical language metadata shared by the STT picker and runtime adapters.
// Adapters translate these stable ids into model-specific language values.

export const STT_LANGUAGE_AUTO = "auto";

const LANGUAGE_DEFINITIONS = [
  { id: STT_LANGUAGE_AUTO, label: "Automatic" },
  { id: "en", label: "English" },
  { id: "es", label: "Spanish" },
  { id: "zh", label: "Chinese" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
];

export const STT_LANGUAGE_OPTIONS = Object.freeze(LANGUAGE_DEFINITIONS);
export const STT_LANGUAGES = Object.freeze(
  Object.fromEntries(LANGUAGE_DEFINITIONS.map((language) => [language.id, language])),
);

export function normalizeSttLanguage(value) {
  const language = String(value ?? "")
    .trim()
    .toLowerCase();
  return STT_LANGUAGES[language] ? language : STT_LANGUAGE_AUTO;
}

export function sttLanguage(value) {
  return STT_LANGUAGES[normalizeSttLanguage(value)];
}

export function sttLanguageLabel(value) {
  return sttLanguage(value).label;
}

export function modelSupportsSttLanguage(model, language) {
  const selected = normalizeSttLanguage(language);
  if (selected === STT_LANGUAGE_AUTO || !Array.isArray(model?.languages)) return true;
  return model.languages.includes(selected);
}
