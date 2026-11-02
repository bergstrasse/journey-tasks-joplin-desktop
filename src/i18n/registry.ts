import chinese from './locales/zh-CN.json';
import english from './locales/en.json';
import ca from './locales/ca.json';
import hr from './locales/hr.json';
import da from './locales/da.json';
import de from './locales/de.json';
import en_GB from './locales/en-GB.json';
import en_US from './locales/en-US.json';
import es from './locales/es.json';
import fi from './locales/fi.json';
import fr from './locales/fr.json';
import id from './locales/id.json';
import it from './locales/it.json';
import hu from './locales/hu.json';
import nl from './locales/nl.json';
import fa from './locales/fa.json';
import pl from './locales/pl.json';
import pt_BR from './locales/pt-BR.json';
import ro_MD from './locales/ro-MD.json';
import ro_RO from './locales/ro-RO.json';
import sk from './locales/sk.json';
import sv from './locales/sv.json';
import tr from './locales/tr.json';
import ru from './locales/ru.json';
import zh_TW from './locales/zh-TW.json';
import ja from './locales/ja.json';

/** Register independently translated JSON files here. Menus and validation follow it. */
export const registry = {
  'zh-CN': { id: 'zh-CN', nativeName: '简体中文', dictionary: chinese },
  en: { id: 'en', nativeName: 'English', dictionary: english },
  'ca': { id: 'ca', nativeName: 'Català', dictionary: ca },
  'hr': { id: 'hr', nativeName: 'Hrvatski', dictionary: hr },
  'da': { id: 'da', nativeName: 'Dansk', dictionary: da },
  'de': { id: 'de', nativeName: 'Deutsch', dictionary: de },
  'en-GB': { id: 'en-GB', nativeName: 'English (United Kingdom)', dictionary: en_GB },
  'en-US': { id: 'en-US', nativeName: 'English (United States)', dictionary: en_US },
  'es': { id: 'es', nativeName: 'Español (España)', dictionary: es },
  'fi': { id: 'fi', nativeName: 'Suomi', dictionary: fi },
  'fr': { id: 'fr', nativeName: 'Français', dictionary: fr },
  'id': { id: 'id', nativeName: 'Bahasa Indonesia', dictionary: id },
  'it': { id: 'it', nativeName: 'Italiano', dictionary: it },
  'hu': { id: 'hu', nativeName: 'Magyar', dictionary: hu },
  'nl': { id: 'nl', nativeName: 'Nederlands', dictionary: nl },
  'fa': { id: 'fa', nativeName: 'فارسی', dictionary: fa },
  'pl': { id: 'pl', nativeName: 'Polski', dictionary: pl },
  'pt-BR': { id: 'pt-BR', nativeName: 'Português (Brasil)', dictionary: pt_BR },
  'ro-MD': { id: 'ro-MD', nativeName: 'Română (Republica Moldova)', dictionary: ro_MD },
  'ro-RO': { id: 'ro-RO', nativeName: 'Română (România)', dictionary: ro_RO },
  'sk': { id: 'sk', nativeName: 'Slovenčina', dictionary: sk },
  'sv': { id: 'sv', nativeName: 'Svenska', dictionary: sv },
  'tr': { id: 'tr', nativeName: 'Türkçe', dictionary: tr },
  'ru': { id: 'ru', nativeName: 'Русский', dictionary: ru },
  'zh-TW': { id: 'zh-TW', nativeName: '繁體中文', dictionary: zh_TW },
  'ja': { id: 'ja', nativeName: '日本語', dictionary: ja },
} as const;
