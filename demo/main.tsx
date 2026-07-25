// The interactive part of the page — toolbar, peer chain, editor and log — is a
// Preact app mounted into #app. The masthead and footer are static chrome in the
// HTML around it.
import { render } from 'preact';
import { DemoModel } from './model';
import { App } from './components/App';

const mount = document.getElementById('app');
if (mount) {
  const model = new DemoModel();
  render(<App model={model} />, mount);
  void model.boot();
}
