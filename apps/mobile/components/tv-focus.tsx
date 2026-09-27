/**
 * Фокус для пульта. Android TV ходит по интерфейсу D-pad'ом: элемент должен
 * быть focusable и заметно подсвечен, иначе непонятно, что нажмётся по Enter.
 *
 * В RN 0.86 TV-API нет (их вынесли в react-native-tvos), поэтому опираемся на
 * нативный фокус Android: `focusable` + onFocus/onBlur. На телефоне это ничего
 * не ломает — там фокус никого не касается, а тач работает как раньше.
 */
import * as React from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { tokens } from "@zal/ui";

export interface TvFocusState {
  focused: boolean;
  /** Раскладывается в Pressable/View: фокусируемость + отслеживание фокуса. */
  props: {
    focusable: true;
    onFocus: () => void;
    onBlur: () => void;
  };
  /** Кольцо фокуса — подмешивается в style активного элемента. */
  ring: StyleProp<ViewStyle>;
}

export function useTvFocus(): TvFocusState {
  const [focused, setFocused] = React.useState(false);
  const onFocus = React.useCallback(() => setFocused(true), []);
  const onBlur = React.useCallback(() => setFocused(false), []);
  return React.useMemo(
    () => ({
      focused,
      props: { focusable: true, onFocus, onBlur },
      ring: focused ? styles.ring : null,
    }),
    [focused, onFocus, onBlur],
  );
}

const styles = StyleSheet.create({
  ring: {
    borderColor: tokens.color.accent,
    borderWidth: 2,
  },
});
