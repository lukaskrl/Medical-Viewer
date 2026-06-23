const NIFTI_IMPORT_KINDS = {
  VOLUME: 'volume',
  SEGMENTATION: 'segmentation',
};

// Strips the volume extension for both NIfTI (.nii/.nii.gz) and NRRD
// (.nrrd/.seg.nrrd/.nhdr) files. ".seg.nrrd" is removed whole so a Slicer
// segmentation collapses to the same base name as its matching volume.
function stripNiftiExtension(fileName) {
  return fileName.replace(/\.(nii\.gz|nii|seg\.nrrd|nrrd|nhdr)$/i, '');
}

function stripSegmentationSuffix(fileName) {
  return fileName.replace(/([_-](seg|mask|segmentation))$/i, '');
}

function normalizeLookupName(fileName) {
  return stripSegmentationSuffix(stripNiftiExtension(fileName)).toLowerCase();
}

function inferNiftiImportKind(fileName) {
  // Segmentation if the name carries a seg/mask suffix (NIfTI or NRRD) or uses
  // the 3D Slicer ".seg.nrrd" convention.
  return /(\.seg\.nrrd|[_-](seg|mask|segmentation)\.(nii\.gz|nii|nrrd|nhdr))$/i.test(fileName)
    ? NIFTI_IMPORT_KINDS.SEGMENTATION
    : NIFTI_IMPORT_KINDS.VOLUME;
}

function scoreStudyMatch(fileName, study) {
  const lookupName = normalizeLookupName(fileName);
  const studyDescriptions = [];

  if (study?.description) {
    studyDescriptions.push(study.description);
  }

  if (study?.series?.length) {
    study.series.forEach(series => {
      if (series?.SeriesDescription) {
        studyDescriptions.push(series.SeriesDescription);
      }
    });
  }

  let score = 0;

  studyDescriptions.forEach(description => {
    const normalizedDescription = String(description).toLowerCase();
    if (normalizedDescription === lookupName) {
      score = Math.max(score, 3);
    } else if (normalizedDescription.includes(lookupName) || lookupName.includes(normalizedDescription)) {
      score = Math.max(score, 2);
    }
  });

  return score;
}

function findMatchingStudyForNifti(fileName, studies) {
  if (!Array.isArray(studies) || !studies.length) {
    return null;
  }

  let bestMatch = null;
  let bestScore = 0;

  studies.forEach(study => {
    const score = scoreStudyMatch(fileName, study);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = study;
    }
  });

  return bestScore > 0 ? bestMatch : null;
}

export {
  NIFTI_IMPORT_KINDS,
  inferNiftiImportKind,
  findMatchingStudyForNifti,
  normalizeLookupName,
  stripNiftiExtension,
  stripSegmentationSuffix,
};
