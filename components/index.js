// eslint-disable-next-line no-unused-vars
import { AsyncAPIDocumentInterface } from '@asyncapi/parser';
import { includeFile, generateBase64Favicon, renderSpec, stringifySpec, stringifyConfiguration } from '../helpers/all';

/**
 * @param {{asyncapi: AsyncAPIDocumentInterface, params: any}} param0 
 */
export function Index({ asyncapi, params = {} }) {
  const favicon = generateBase64Favicon(params);
  const renderedSpec = renderSpec(asyncapi, params);
  let asyncapiScript = `<script src="js/asyncapi-ui.min.js" type="application/javascript"></script>`;
  // coerce singleFile param to bool, or "false" string will be true
  const singleFile = (params?.singleFile === true  || params?.singleFile == 'true');
  if(singleFile) {
    asyncapiScript = `<script type="text/javascript">
    ${includeFile('template/js/asyncapi-ui.min.js')}
    </script>`;
  }
  let styling = `<link href="css/global.min.css" rel="stylesheet">
      <link href="css/asyncapi.min.css" rel="stylesheet">`;
  if(singleFile) {
    styling = `<style type="text/css">
      ${includeFile("template/css/global.min.css")}
      ${includeFile("template/css/asyncapi.min.css")}
    </style>`;
  }
  let basehref = '';
  if(params.baseHref) {
    basehref = `<base href="${params.baseHref}">`;
  }
  let appJs = `<script type="application/javascript" src="js/app.js"></script>`;
  if(singleFile) {
    appJs = `<script>${App({asyncapi, params})}</script>`;
  }
  return (`<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8">
      ${basehref}
      <title>${asyncapi.info().title()} ${asyncapi.info().version()} documentation</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="icon" type="image/x-icon" href="${favicon}" />
      ${styling}
    </head>
  
    <body>
      <div id="root">${renderedSpec}</div>
  
      ${asyncapiScript}
  
      ${appJs}

      <script>
      // Add copy-to-clipboard buttons to all code blocks
      (function() {
        function addCopyButtons() {
          document.querySelectorAll('pre').forEach(function(pre) {
            if (pre.querySelector('.copy-btn')) return;
            var btn = document.createElement('button');
            btn.className = 'copy-btn';
            btn.textContent = '\u2398';
            btn.title = 'Copy to clipboard';
            btn.setAttribute('aria-label', 'Copy to clipboard');
            btn.style.cssText = 'position:absolute;top:6px;right:6px;background:rgba(255,255,255,0.15);color:#ccc;border:1px solid rgba(255,255,255,0.2);border-radius:4px;padding:2px 7px;cursor:pointer;font-size:14px;line-height:1.2;opacity:0;transition:opacity 0.15s';
            pre.style.position = 'relative';
            pre.addEventListener('mouseenter', function() { btn.style.opacity = '1'; });
            pre.addEventListener('mouseleave', function() { btn.style.opacity = '0'; });
            btn.addEventListener('mouseenter', function() { btn.style.opacity = '1'; });
            btn.addEventListener('focus', function() { btn.style.opacity = '1'; });
            btn.addEventListener('blur', function() { btn.style.opacity = '0'; });
            btn.addEventListener('click', function() {
              var code = pre.querySelector('code');
              var text = (code || pre).textContent;
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function() {
                  btn.textContent = '\u2713';
                  btn.style.color = '#68d391';
                  setTimeout(function() { btn.textContent = '\u2398'; btn.style.color = '#ccc'; }, 1500);
                }).catch(function() {
                  btn.textContent = '\u2717';
                  btn.style.color = '#fc8181';
                  setTimeout(function() { btn.textContent = '\u2398'; btn.style.color = '#ccc'; }, 1500);
                });
              }
            });
            pre.appendChild(btn);
          });
        }
        // Run after hydration and on DOM mutations (React re-renders)
        var observer = new MutationObserver(function() { addCopyButtons(); });
        observer.observe(document.getElementById('root'), { childList: true, subtree: true });
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', addCopyButtons);
        } else {
          addCopyButtons();
        }
      })();
      </script>
    </body>
  </html>`
  );
}

export function App({ asyncapi, params = {} }) {
  return (`
    const schema = ${stringifySpec(asyncapi)};
    const config = ${stringifyConfiguration(params)};
    const appRoot = document.getElementById('root');
    AsyncApiStandalone.render(
        { schema, config, }, appRoot
    );
  `
  );
}
