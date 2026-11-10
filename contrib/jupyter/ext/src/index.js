import { ILabShell, ILayoutRestorer } from '@jupyterlab/application';
import { PageConfig } from '@jupyterlab/coreutils';
import { LabIcon } from '@jupyterlab/ui-components';
import { Widget } from '@lumino/widgets';

const scooterIcon = new LabIcon({
  name: 'scooter:chat',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g class="jp-icon3" fill="#616161">' +
    '<path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></g></svg>'
});

// Shown once; afterwards the layout restorer remembers.
const SEEN = 'scooter.jupyter.chatSeen';

const plugin = {
  id: 'scooter-jupyter-chat:plugin',
  description: 'This Scooter conversation as a sidebar panel.',
  autoStart: true,
  requires: [ILabShell],
  optional: [ILayoutRestorer],
  activate: (app, shell, restorer) => {
    const chatUrl = PageConfig.getOption('scooterChatUrl');
    const widget = new Widget();
    widget.id = 'scooter-chat';
    widget.addClass('jp-ScooterChat');
    widget.title.icon = scooterIcon;
    widget.title.caption = 'Scooter chat';
    if (chatUrl) {
      const frame = document.createElement('iframe');
      frame.title = 'Scooter chat';
      // The sidebar is narrow, so ask for the compact layout.
      const url = new URL(chatUrl);
      if (!url.searchParams.has('density')) url.searchParams.set('density', 'compact');
      frame.src = url.toString();
      frame.allow = 'clipboard-read; clipboard-write; fullscreen';
      widget.node.appendChild(frame);
    } else {
      widget.node.innerHTML = '<p class="jp-ScooterChat-missing">No chat URL: this sandbox has no CONVERSATION_URL.</p>';
    }
    shell.add(widget, 'left', { rank: 0 });
    if (restorer) restorer.add(widget, widget.id);
    app.restored.then(() => {
      if (!localStorage.getItem(SEEN)) {
        localStorage.setItem(SEEN, '1');
        shell.activateById(widget.id);
      }
    });
  }
};

export default plugin;
