import * as React from 'react';
import { Tabs, Tab, Box, Typography, Grid, styled } from '@mui/material';
import { makeStyles } from 'tss-react/mui';
import ConfigContext from "./ConfigContext";
import useSettings, { setConfigValues } from "./useSettings";

const ipc = window.electron.ipcRenderer;

function a11yProps(index: number) {
  return {
    id: `vertical-tab-${index}`,
    'aria-controls': `vertical-tabpanel-${index}`,
  };
}

async function setupPreview(container: any) {
  const { width, height, x, y } = container.getBoundingClientRect();
  const result = await ipc.invoke('preview', ['init', { width, height, x, y }]);
  console.log(result);
  container.style = `height: ${result.height}px`;
}

async function resizePreview(container: any) {
  const { width, height, x, y } = container.getBoundingClientRect();
  const result = await ipc.invoke('preview', ['bounds', { width, height, x, y }]);
  container.style = `height: ${result.height}px`;
}

export default function SceneEditor() {
  const [config, setConfig] = useSettings();
  const [tabIndex, setTabIndex] = React.useState(0);

  const handleChangeTab = (_event: React.SyntheticEvent, newValue: number) => {
    setTabIndex(newValue);
  };

  /**
   * Close window.
   */
  const closeWindow = () => {
    ipc.sendMessage('settingsWindow', ['quit']);
  }

  /**
   * Save values. 
   */
  const saveSettings = () => {
    console.info("[Scene Editor] User clicked save settings");

    setConfigValues(config);

    closeWindow();
    ipc.sendMessage('settingsWindow', ['update']);
  }


  /**
   * Needed to style the tabs with the right color.
   */
  const useStyles = makeStyles()({
    tabs: {
      "& .MuiTab-root.Mui-selected": {
        color: '#bb4220'
      },
      scrollButtons: { // this does nothing atm
        "&.Mui-disabled": {
          opacity: 1
        }
      }
    },
    box: {
      padding: '1em',
      flexGrow: 1,
      justifyContent: 'center',
      display: 'flex',
      height: '100%',
    },

    preview: {
      width: '800px',
      height: '600px',
    },
  });

  React.useEffect(() => {
    const container = document.getElementById('video-preview');
    setupPreview(container)
  }, []);

  /**
  * MUI styles.
  */
   const { classes: styles } = useStyles();

  return (
    <ConfigContext.Provider value={[config, setConfig]}>
      <Box className={ styles.box }>
        <Grid container>
          <Grid item xs={12}>
            <div id='scene-editor'>
              <div id='video-preview' className={ styles.preview }></div>
            </div>
          </Grid>

{ /*
          <Grid item xs={2}>
            <button type="button" id="close" name="close" className="btn btn-secondary" onClick={closeWindow}>Close</button>
          </Grid>
          <Grid item xs={2}>
            <button type="button" id="submit" name="save" className="btn btn-primary" onClick={saveSettings}>Save</button>
          </Grid>
*/}
        </Grid>
      </Box>
    </ConfigContext.Provider>
  );
}