import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import SceneEditor from './SceneEditor';
import AppTitleBar from './AppTitleBar';
import '../renderer/App.css';


const Application = () => {
  return (
    <div className="App">
      <AppTitleBar/>
      <SceneEditor />
    </div>
  );
};

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Application />} />
      </Routes>
    </Router>
  );
}
