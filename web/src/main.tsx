import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
// latin + latin-ext only (Polish names in user data); bundled locally, the machine may be offline
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-ext-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-ext-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-ext-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-ext-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-ext-500.css';
import '@xyflow/react/dist/style.css';
import './app.css'; // after React Flow's CSS, so the --xy-* overrides win
import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ActionIcon, Button, Checkbox, Code, colorsTuple, createTheme, MantineProvider, PasswordInput, SegmentedControl, Select, Stack, Switch, Text, Textarea, TextInput,
  type CSSVariablesResolver, type MantineColorsTuple,
} from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { App } from './App';

// Token table from docs/design/ui-pipeline.md; the --cirt-* variables switch with the color scheme.
const TOKENS = {
  ink: ['#0E1923', '#EEF2F5'], panel: ['#15232F', '#FFFFFF'], rail: ['#2C4558', '#B9C7D3'],
  cobalt: ['#4F7CFF', '#2F5BE0'], go: ['#36D399', '#12925F'], stop: ['#FF6363', '#D33A3A'], caution: ['#F4C04E', '#B7860B'],
} as const;
const scheme = (i: 0 | 1) => Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [`--cirt-${k}`, v[i]]));
const resolver: CSSVariablesResolver = () => ({
  variables: {},
  dark: { ...scheme(0), '--mantine-color-body': TOKENS.ink[0], '--mantine-color-default-border': TOKENS.rail[0], '--mantine-color-default': TOKENS.ink[0] },
  light: { ...scheme(1), '--mantine-color-body': TOKENS.ink[1], '--mantine-color-default-border': TOKENS.rail[1], '--mantine-color-text': '#14212C', '--mantine-color-dimmed': '#4E6273' },
});

// Mantine's dark palette re-tinted to slate: 0 text, 2 dimmed, 4 border, 5 hover, 6 inputs, 7 body
const slate: MantineColorsTuple = ['#D5DEE6', '#B5C3D0', '#8FA2B4', '#647A8E', '#2C4558', '#1E3242', '#15232F', '#0E1923', '#0A131B', '#060C12'];
const xs = { defaultProps: { size: 'xs' } };
const theme = createTheme({
  primaryColor: 'cobalt',
  colors: {
    dark: slate,
    cobalt: colorsTuple('var(--cirt-cobalt)'), go: colorsTuple('var(--cirt-go)'), stop: colorsTuple('var(--cirt-stop)'), caution: colorsTuple('var(--cirt-caution)'),
  },
  fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
  fontFamilyMonospace: '"JetBrains Mono", ui-monospace, Consolas, monospace',
  headings: { fontFamily: '"IBM Plex Sans", system-ui, sans-serif', fontWeight: '600' },
  fontSizes: { xs: '12px', sm: '13px', md: '15px', lg: '20px', xl: '28px' },
  defaultRadius: 4,
  cursorType: 'pointer',
  respectReducedMotion: true,
  components: {
    Button: Button.extend(xs), TextInput: TextInput.extend(xs), PasswordInput: PasswordInput.extend(xs), Textarea: Textarea.extend(xs),
    Select: Select.extend(xs), Checkbox: Checkbox.extend(xs), Switch: Switch.extend({ defaultProps: { size: 'sm' } }),
    SegmentedControl: SegmentedControl.extend(xs), ActionIcon: ActionIcon.extend({ defaultProps: { size: 'sm' } }),
    Text: Text.extend({ defaultProps: { size: 'sm' } }),
  },
});

/** A render error shows what broke and a way out instead of a white screen. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Stack align="center" justify="center" h="100vh" p="xl" gap="sm" role="alert">
        <Text size="lg" fw={600}>Something went wrong</Text>
        <Code block maw={720} style={{ whiteSpace: 'pre-wrap' }}>{error.message || String(error)}</Code>
        <Text c="dimmed">Unsaved changes in this tab are lost after a reload; saved data is on disk.</Text>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </Stack>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark" cssVariablesResolver={resolver}>
      <Notifications position="bottom-right" />
      <ErrorBoundary><App /></ErrorBoundary>
    </MantineProvider>
  </StrictMode>,
);
